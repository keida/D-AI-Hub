import { describe, expect, it } from "vitest";
import type { DurableContextManifest, VerificationEvidence } from "../../src/domain/types.js";
import type { RecoveryPointCaptureInput } from "../../src/recovery/recovery-point-service.js";

function createManifest(): DurableContextManifest {
  return {
    manifestId: "00000000-0000-4000-8000-000000000001",
    taskId: "task-recovery",
    stage: "execute",
    environment: "codex",
    role: "implementer",
    durablePaths: ["context.json", "state.json", "manifest.json", "recovery.json"],
    hashes: { "context.json": "a".repeat(64), "state.json": "b".repeat(64), "manifest.json": "c".repeat(64), "recovery.json": "d".repeat(64) },
    recoveryPointId: null,
    recordedAt: "2026-08-21T00:00:00.000Z",
  };
}

function createVerification(): VerificationEvidence {
  return {
    evidenceId: "evidence-1",
    stage: "verify",
    environment: "codex",
    role: "evidence-collector",
    selectedModel: "model",
    command: "npm test",
    observedOutput: "all tests passed",
    exitCode: 0,
    interpretation: "Quality passed",
    passed: true,
    recoveryPointId: null,
    recordedAt: "2026-08-21T00:00:00.000Z",
  };
}

function createCaptureInput(verificationResults: readonly VerificationEvidence[], createdAt: string): RecoveryPointCaptureInput {
  return {
    recoveryPointId: "recovery-1",
    taskId: "task-recovery",
    trigger: "risky-work",
    stage: "execute",
    environment: "codex",
    role: "implementer",
    head: "0123456789abcdef0123456789abcdef01234567",
    branch: "feat/task-7",
    workspacePath: "C:/workspace",
    status: " M src/example.ts",
    binaryPatch: "diff --git a/src/example.ts b/src/example.ts",
    stateManifest: createManifest(),
    verificationResults,
    createdAt,
  };
}

describe("createRecoveryPoint", () => {
  it("captures the complete known-good state before risky work", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const point = createRecoveryPoint(createCaptureInput([createVerification()], "2026-08-21T00:00:00.000Z"));

    expect(point).toMatchObject({
      trigger: "risky-work",
      snapshot: expect.objectContaining({ head: "0123456789abcdef0123456789abcdef01234567", branch: "feat/task-7", workspacePath: "C:/workspace" }),
      recoveryPoint: expect.objectContaining({ recoveryPointId: "recovery-1", taskId: "task-recovery" }),
    });
    expect(point.snapshot.durableArtifacts).toEqual(point.recoveryPoint.hashes);
  });

  it("rejects capture without verification evidence", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");

    expect(() => createRecoveryPoint(createCaptureInput([], "2026-08-21T00:00:00.000Z"))).toThrow(/verification.*required/i);
  });

  it("rejects incomplete verification evidence", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const incompleteEvidence: readonly VerificationEvidence[] = [
      { ...createVerification(), evidenceId: "" },
      { ...createVerification(), selectedModel: "" },
      { ...createVerification(), command: "" },
      { ...createVerification(), observedOutput: "" },
      { ...createVerification(), interpretation: "" },
    ];

    for (const evidence of incompleteEvidence) {
      expect(() => createRecoveryPoint(createCaptureInput([evidence], "2026-08-21T00:00:00.000Z"))).toThrow(/non-empty/i);
    }
  });

  it("rejects stale or future verification evidence", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const stale = { ...createVerification(), recordedAt: "2026-08-20T23:54:59.999Z" };
    const future = { ...createVerification(), recordedAt: "2026-08-21T00:00:00.001Z" };

    expect(() => createRecoveryPoint(createCaptureInput([stale], "2026-08-21T00:00:00.000Z"))).toThrow(/stale/i);
    expect(() => createRecoveryPoint(createCaptureInput([future], "2026-08-21T00:00:00.000Z"))).toThrow(/future/i);
  });

  it("rejects verification evidence that is failed or did not exit successfully", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const failed = { ...createVerification(), passed: false, exitCode: 1 };
    const inconsistent = { ...createVerification(), exitCode: 1 };

    expect(() => createRecoveryPoint(createCaptureInput([failed], "2026-08-21T00:00:00.000Z"))).toThrow(/passed/i);
    expect(() => createRecoveryPoint(createCaptureInput([inconsistent], "2026-08-21T00:00:00.000Z"))).toThrow(/exit code 0/i);
  });

  it("deep-clones the state manifest in the captured snapshot", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const input = createCaptureInput([createVerification()], "2026-08-21T00:00:00.000Z");
    const captured = createRecoveryPoint(input);

    (input.stateManifest as { hashes: Record<string, string> }).hashes["context.json"] = "f".repeat(64);
    expect(captured.snapshot.stateManifest.hashes["context.json"]).toBe("a".repeat(64));
    expect(captured.snapshot.stateManifest).not.toBe(input.stateManifest);
  });

  it.each(["ghp_123456789012345678901234567890", "sk_123456789012345678901234567890", "-----BEGIN PRIVATE KEY-----"])(
    "rejects unsafe snapshot manifest ids: %s",
    async (manifestId) => {
      const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
      expect(() => createRecoveryPoint({ ...createCaptureInput([createVerification()], "2026-08-21T00:00:00.000Z"), stateManifest: { ...createManifest(), manifestId } })).toThrow(/manifest id/i);
    },
  );
});
