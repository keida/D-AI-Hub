import { describe, expect, it } from "vitest";
import { CommandExecutionError } from "../../src/adapters/command-runner.js";
import { TaskOwnershipError } from "../../src/domain/errors.js";

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
      stateManifest: { manifestId: "00000000-0000-4000-8000-000000000002", taskId: "task-rollback", stage: "recover", environment: "codex", role: "recovery-operator", durablePaths: ["state.json"], hashes: { "state.json": "b".repeat(64) }, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" },
      verificationResults: [{ evidenceId: "evidence-rollback", stage: "verify", environment: "codex", role: "evidence-collector", selectedModel: "model", command: "npm test", observedOutput: "all tests passed", exitCode: 0, interpretation: "Quality passed", passed: true, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" }],
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

  it("returns completed actions when recovery verification fails", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const { safeRollback } = await import("../../src/recovery/rollback.js");
    const point = createRecoveryPoint({
      recoveryPointId: "recovery-partial-rollback",
      taskId: "task-partial-rollback",
      trigger: "recovery",
      stage: "recover",
      environment: "codex",
      role: "recovery-operator",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "feat/task-7",
      workspacePath: "C:/workspace",
      status: "clean",
      binaryPatch: "",
      stateManifest: { manifestId: "00000000-0000-4000-8000-000000000003", taskId: "task-partial-rollback", stage: "recover", environment: "codex", role: "recovery-operator", durablePaths: ["state.json"], hashes: { "state.json": "b".repeat(64) }, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" },
      verificationResults: [{ evidenceId: "evidence-partial-rollback", stage: "verify", environment: "codex", role: "evidence-collector", selectedModel: "model", command: "npm test", observedOutput: "passed", exitCode: 0, interpretation: "passed", passed: true, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" }],
      createdAt: "2026-08-21T00:00:00.000Z",
    });
    const result = await safeRollback({
      recoveryPoint: point,
      commitsToRevert: [],
      adapter: {
        async preserveUncommittedWork() { return { archiveId: "user-work-2", patchDigest: "c".repeat(64) }; },
        async revertCommit() { throw new Error("not expected"); },
        async restoreRecoveryPatch() { return { command: "git", arguments: ["apply"], stdout: "restored", stderr: "", exitCode: 0 }; },
        async verifyRecoveryPoint() { return { passed: false, observedOutput: "mismatch", reason: "tree mismatch" }; },
      },
    });

    expect(result).toMatchObject({
      actions: [{ command: "git", arguments: ["apply"] }],
      verification: { passed: false, reason: "tree mismatch" },
    });
  });

  it("throws a typed partial failure after an earlier rollback action succeeds", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const { safeRollback } = await import("../../src/recovery/rollback.js");
    const point = createRecoveryPoint({
      recoveryPointId: "recovery-action-failure",
      taskId: "task-action-failure",
      trigger: "recovery",
      stage: "recover",
      environment: "codex",
      role: "recovery-operator",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "feat/task-7",
      workspacePath: "C:/workspace",
      status: "clean",
      binaryPatch: "",
      stateManifest: { manifestId: "00000000-0000-4000-8000-000000000004", taskId: "task-action-failure", stage: "recover", environment: "codex", role: "recovery-operator", durablePaths: ["state.json"], hashes: { "state.json": "b".repeat(64) }, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" },
      verificationResults: [{ evidenceId: "evidence-action-failure", stage: "verify", environment: "codex", role: "evidence-collector", selectedModel: "model", command: "npm test", observedOutput: "passed", exitCode: 0, interpretation: "passed", passed: true, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" }],
      createdAt: "2026-08-21T00:00:00.000Z",
    });

    await expect(safeRollback({
      recoveryPoint: point,
      commitsToRevert: ["1234567890abcdef1234567890abcdef12345678", "abcdefabcdefabcdefabcdefabcdefabcdefabcd"],
      adapter: {
        async preserveUncommittedWork() { return { archiveId: "user-work-3", patchDigest: "c".repeat(64) }; },
        async revertCommit(commit: string) {
          if (commit.startsWith("abc")) {
            throw new CommandExecutionError({ command: "git", arguments: ["revert", "--no-edit", commit], stdout: "", stderr: "second revert failed token=rollback-secret", exitCode: 1 });
          }
          return { command: "git", arguments: ["revert", "--no-edit", commit], stdout: "reverted", stderr: "", exitCode: 0 };
        },
        async restoreRecoveryPatch() { throw new Error("not expected"); },
        async verifyRecoveryPoint() { throw new Error("not expected"); },
      },
    })).rejects.toMatchObject({
      name: "RollbackPartialFailureError",
      result: {
        actions: [
          { arguments: ["revert", "--no-edit", "1234567890abcdef1234567890abcdef12345678"], exitCode: 0 },
          { arguments: ["revert", "--no-edit", "abcdefabcdefabcdefabcdefabcdefabcdefabcd"], stderr: "second revert failed token=[REDACTED]", exitCode: 1 },
        ],
        verification: { passed: false },
      },
    });
  });

  it("retains completed actions when ownership is lost before the next rollback operation", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const { safeRollback } = await import("../../src/recovery/rollback.js");
    const point = createRecoveryPoint({
      recoveryPointId: "recovery-ownership-loss",
      taskId: "task-ownership-loss",
      trigger: "recovery",
      stage: "recover",
      environment: "codex",
      role: "recovery-operator",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "feat/task-7",
      workspacePath: "C:/workspace",
      status: "clean",
      binaryPatch: "",
      stateManifest: { manifestId: "00000000-0000-4000-8000-000000000007", taskId: "task-ownership-loss", stage: "recover", environment: "codex", role: "recovery-operator", durablePaths: ["state.json"], hashes: { "state.json": "b".repeat(64) }, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" },
      verificationResults: [{ evidenceId: "evidence-ownership-loss", stage: "verify", environment: "codex", role: "evidence-collector", selectedModel: "model", command: "npm test", observedOutput: "passed", exitCode: 0, interpretation: "Quality passed", passed: true, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" }],
      createdAt: "2026-08-21T00:00:00.000Z",
    });

    await expect(safeRollback({
      recoveryPoint: point,
      commitsToRevert: ["1234567890abcdef1234567890abcdef12345678", "abcdefabcdefabcdefabcdefabcdefabcdefabcd"],
      adapter: {
        async preserveUncommittedWork() { return { archiveId: "user-work-ownership", patchDigest: "c".repeat(64) }; },
        async revertCommit(commit: string) {
          if (commit.startsWith("abc")) throw new TaskOwnershipError("Rollback ownership was lost after the first revert");
          return { command: "git", arguments: ["revert", "--no-edit", commit], stdout: "reverted", stderr: "", exitCode: 0 };
        },
        async restoreRecoveryPatch() { throw new Error("not expected"); },
        async verifyRecoveryPoint() { throw new Error("not expected"); },
      },
    })).rejects.toMatchObject({
      name: "RollbackPartialFailureError",
      result: {
        actions: [{ arguments: ["revert", "--no-edit", "1234567890abcdef1234567890abcdef12345678"], exitCode: 0 }],
        verification: { passed: false, reason: expect.stringMatching(/ownership/i) },
      },
    });
  });

  it("persists a partial audit when preserve-stage Git inspection fails", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const { safeRollback } = await import("../../src/recovery/rollback.js");
    const point = createRecoveryPoint({
      recoveryPointId: "recovery-preserve-failure",
      taskId: "task-preserve-failure",
      trigger: "recovery",
      stage: "recover",
      environment: "codex",
      role: "recovery-operator",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "feat/task-7",
      workspacePath: "C:/workspace",
      status: "clean",
      binaryPatch: "",
      stateManifest: { manifestId: "00000000-0000-4000-8000-000000000006", taskId: "task-preserve-failure", stage: "recover", environment: "codex", role: "recovery-operator", durablePaths: ["state.json"], hashes: { "state.json": "b".repeat(64) }, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" },
      verificationResults: [{ evidenceId: "evidence-preserve-failure", stage: "verify", environment: "codex", role: "evidence-collector", selectedModel: "model", command: "npm test", observedOutput: "passed", exitCode: 0, interpretation: "passed", passed: true, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" }],
      createdAt: "2026-08-21T00:00:00.000Z",
    });

    await expect(safeRollback({
      recoveryPoint: point,
      commitsToRevert: [],
      adapter: {
        async preserveUncommittedWork() {
          throw new CommandExecutionError({ command: "git", arguments: ["rev-parse", "stash@{0}"], stdout: "", stderr: "stash inspection failed token=preserve-secret", exitCode: 1 });
        },
        async revertCommit() { throw new Error("not expected"); },
        async restoreRecoveryPatch() { throw new Error("not expected"); },
        async verifyRecoveryPoint() { throw new Error("not expected"); },
      },
    })).rejects.toMatchObject({
      name: "RollbackPartialFailureError",
      result: {
        preservedUserWork: { archiveId: "preserve-failed", patchDigest: "0".repeat(64) },
        actions: [{ command: "git", arguments: ["rev-parse", "stash@{0}"], stderr: "stash inspection failed token=[REDACTED]", exitCode: 1 }],
        verification: { passed: false },
      },
    });
  });

  it("throws a typed partial failure when recovery verification raises", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const { safeRollback } = await import("../../src/recovery/rollback.js");
    const point = createRecoveryPoint({
      recoveryPointId: "recovery-verification-failure",
      taskId: "task-verification-failure",
      trigger: "recovery",
      stage: "recover",
      environment: "codex",
      role: "recovery-operator",
      head: "0123456789abcdef0123456789abcdef01234567",
      branch: "feat/task-7",
      workspacePath: "C:/workspace",
      status: "clean",
      binaryPatch: "",
      stateManifest: { manifestId: "00000000-0000-4000-8000-000000000005", taskId: "task-verification-failure", stage: "recover", environment: "codex", role: "recovery-operator", durablePaths: ["state.json"], hashes: { "state.json": "b".repeat(64) }, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" },
      verificationResults: [{ evidenceId: "evidence-verification-failure", stage: "verify", environment: "codex", role: "evidence-collector", selectedModel: "model", command: "npm test", observedOutput: "passed", exitCode: 0, interpretation: "passed", passed: true, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" }],
      createdAt: "2026-08-21T00:00:00.000Z",
    });

    await expect(safeRollback({
      recoveryPoint: point,
      commitsToRevert: [],
      adapter: {
        async preserveUncommittedWork() { return { archiveId: "user-work-4", patchDigest: "c".repeat(64) }; },
        async revertCommit() { throw new Error("not expected"); },
        async restoreRecoveryPatch() { return { command: "git", arguments: ["apply"], stdout: "restored", stderr: "", exitCode: 0 }; },
        async verifyRecoveryPoint() { throw new Error("verification failed token=verification-secret"); },
      },
    })).rejects.toMatchObject({
      name: "RollbackPartialFailureError",
      result: { actions: [{ command: "git", arguments: ["apply"] }], verification: { passed: false, reason: "verification failed token=[REDACTED]" } },
    });
  });
});
