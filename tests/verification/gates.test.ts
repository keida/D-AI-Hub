import { describe, expect, it } from "vitest";
import type { TaskState, VerificationEvidence } from "../../src/domain/types.js";

function createState(): TaskState {
  return {
    taskId: "task-gates",
    goal: "Verify a safe task",
    constraints: ["Do not use destructive reset"],
    environment: "codex",
    stage: "verify",
    role: "evidence-collector",
    routingDecision: null,
    selectedCapabilities: ["shell"],
    contextManifest: ["workspace:example"],
    handoffState: "acknowledged",
    verificationEvidence: [],
    recoveryPoint: {
      recoveryPointId: "recovery-1",
      taskId: "task-gates",
      stage: "verify",
      environment: "codex",
      role: "evidence-collector",
      durablePaths: ["manifest.json"],
      hashes: { "manifest.json": "a".repeat(64) },
      restorationInstructions: "Use auditable revert only.",
      createdAt: "2026-08-21T00:00:00.000Z",
    },
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext: {
      manifestId: "manifest-1",
      taskId: "task-gates",
      stage: "verify",
      environment: "codex",
      role: "evidence-collector",
      durablePaths: ["manifest.json"],
      hashes: { "manifest.json": "a".repeat(64) },
      recoveryPointId: "recovery-1",
      recordedAt: "2026-08-21T00:00:00.000Z",
    },
  };
}

function createEvidence(stage: VerificationEvidence["stage"], passed: boolean, recordedAt: string): VerificationEvidence {
  return {
    evidenceId: `evidence-${stage}`,
    stage,
    environment: "codex",
    role: "evidence-collector",
    selectedModel: "model",
    command: "npm test",
    observedOutput: passed ? "1 test passed" : "1 test failed",
    exitCode: passed ? 0 : 1,
    interpretation: passed ? "Verification completed" : "Verification failed",
    passed,
    recoveryPointId: "recovery-1",
    recordedAt,
  };
}

describe("evaluateHardGates", () => {
  it("raises a typed process failure without exposing a token-like process output", async () => {
    const { runCommand } = await import("../../src/adapters/command-runner.js");

    await expect(runCommand({
      command: process.execPath,
      arguments: ["-e", "process.stderr.write('token=unsafe-value'); process.exit(7)"],
      cwd: null,
    })).rejects.toMatchObject({
      name: "CommandExecutionError",
      result: { stderr: "token=[REDACTED]", exitCode: 7 },
    });
  });

  it("fails a quality gate when its fresh evidence reports a failed quality check", async () => {
    const { evaluateHardGates } = await import("../../src/verification/gates.js");
    const now = new Date("2026-08-21T00:10:00.000Z");
    const result = evaluateHardGates({
      state: createState(),
      evidence: [{ gate: "quality", verification: createEvidence("verify", false, "2026-08-21T00:09:00.000Z") }],
      now,
      maximumEvidenceAgeMs: 60_000,
    });

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: "quality", passed: false, exitCode: 1 }),
    ]));
  });

  it("fails closed when a required gate has no evidence or only stale evidence", async () => {
    const { evaluateHardGates } = await import("../../src/verification/gates.js");
    const result = evaluateHardGates({
      state: createState(),
      evidence: [{ gate: "scope", verification: createEvidence("plan", true, "2026-08-21T00:00:00.000Z") }],
      now: new Date("2026-08-21T00:10:00.000Z"),
      maximumEvidenceAgeMs: 60_000,
    });

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: "scope", passed: false, reason: expect.stringMatching(/stale/i) }),
      expect.objectContaining({ gate: "remote-durability", passed: false, reason: expect.stringMatching(/missing/i) }),
    ]));
  });
});
