import { describe, expect, it } from "vitest";
import type { DurableContextManifest, VerificationEvidence } from "../../src/domain/types.js";

function createManifest(): DurableContextManifest {
  return {
    manifestId: "manifest-1",
    taskId: "task-recovery",
    stage: "execute",
    environment: "codex",
    role: "implementer",
    durablePaths: ["state.json"],
    hashes: { "state.json": "b".repeat(64) },
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

describe("createRecoveryPoint", () => {
  it("captures the complete known-good state before risky work", async () => {
    const { createRecoveryPoint } = await import("../../src/recovery/recovery-point-service.js");
    const point = createRecoveryPoint({
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
      verificationResults: [createVerification()],
      createdAt: "2026-08-21T00:00:00.000Z",
    });

    expect(point).toMatchObject({
      trigger: "risky-work",
      snapshot: expect.objectContaining({ head: "0123456789abcdef0123456789abcdef01234567", branch: "feat/task-7", workspacePath: "C:/workspace" }),
      recoveryPoint: expect.objectContaining({ recoveryPointId: "recovery-1", taskId: "task-recovery" }),
    });
  });
});
