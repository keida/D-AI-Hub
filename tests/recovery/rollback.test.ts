import { describe, expect, it } from "vitest";

describe("safeRollback", () => {
  it("preserves user work, uses auditable revert, and verifies restoration", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const { safeRollback } = await import("../../src/recovery/rollback.js");
    const point = createRecoveryPoint({
      recoveryPointId: "recovery-rollback",
      taskId: "task-rollback",
      trigger: "recovery",
      stage: "recover",
      environment: "codex",
      role: "recovery-operator",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "feat/task-7",
      workspacePath: "C:/workspace",
      status: " M src/example.ts",
      binaryPatch: "diff --git a/src/example.ts b/src/example.ts",
      stateManifest: { manifestId: "manifest-1", taskId: "task-rollback", stage: "recover", environment: "codex", role: "recovery-operator", durablePaths: ["state.json"], hashes: { "state.json": "b".repeat(64) }, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" },
      verificationResults: [],
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    const events: string[] = [];
    const result = await safeRollback({
      recoveryPoint: point,
      commitsToRevert: ["1234567890abcdef1234567890abcdef12345678"],
      adapter: {
        async preserveUncommittedWork() {
          events.push("preserve");
          return { archiveId: "user-work-1", patchDigest: "c".repeat(64) };
        },
        async revertCommit(commit: string) {
          events.push(`revert:${commit}`);
          return { command: "git", arguments: ["revert", "--no-edit", commit], stdout: "reverted", stderr: "", exitCode: 0 };
        },
        async restoreRecoveryPatch(binaryPatch: string) {
          events.push(`restore:${binaryPatch}`);
          return { command: "git", arguments: ["apply", "--binary"], stdout: "restored", stderr: "", exitCode: 0 };
        },
        async verifyRecoveryPoint() {
          events.push("verify");
          return { passed: true, observedOutput: "HEAD and workspace match recovery point", reason: "Restoration verified" };
        },
      },
    });

    expect(events).toEqual([
      "preserve",
      "revert:1234567890abcdef1234567890abcdef12345678",
      "restore:diff --git a/src/example.ts b/src/example.ts",
      "verify",
    ]);
    expect(result).toMatchObject({ preservedUserWork: { archiveId: "user-work-1" }, verification: { passed: true } });
  });
});
