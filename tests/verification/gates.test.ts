import { describe, expect, it } from "vitest";
import type { TaskState, VerificationEvidence } from "../../src/domain/types.js";
import type { GateName } from "../../src/verification/gates.js";

function createState(verificationEvidence: readonly VerificationEvidence[]): TaskState {
  return {
    taskId: "task-gates",
    goal: "Verify a safe task",
    constraints: ["Do not use destructive reset"],
    environment: "codex",
    stage: "verify",
    role: "evidence-collector",
    routingDecision: {
      stage: "verify",
      environment: "codex",
      role: "evidence-collector",
      selectedModel: "model",
      selectedCapabilities: ["shell"],
      reason: "Codex can run local verification",
      overrideSource: "default",
    },
    selectedCapabilities: ["shell"],
    contextManifest: ["workspace:example"],
    handoffState: "acknowledged",
    verificationEvidence,
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
  it("redacts authorization bearer tokens from process arguments, stdout, and stderr", async () => {
    const { CommandExecutionError, runCommand } = await import("../../src/adapters/command-runner.js");
    const token = "argument-output-secret";
    const execution = runCommand({
      command: process.execPath,
      arguments: ["-e", "process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]); process.exit(7)", `Authorization: Bearer ${token}`],
      cwd: null,
    });

    await expect(execution).rejects.toSatisfy((error: InstanceType<typeof CommandExecutionError>) => {
      return !JSON.stringify(error.result).includes(token);
    });
  });

  it("redacts authorization bearer tokens from process launch errors", async () => {
    const { CommandExecutionError, runCommand } = await import("../../src/adapters/command-runner.js");
    const token = "launch-error-secret";
    const execution = runCommand({
      command: `missing-Authorization: Bearer ${token}`,
      arguments: [],
      cwd: null,
    });

    await expect(execution).rejects.toSatisfy((error: InstanceType<typeof CommandExecutionError>) => {
      return !JSON.stringify(error.result).includes(token);
    });
  });

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
    const evidence = createEvidence("verify", false, "2026-08-21T00:09:00.000Z");
    const result = evaluateHardGates({
      state: createState([evidence]),
      evidence: [{ gate: "quality", verification: evidence }],
      now,
      maximumEvidenceAgeMs: 60_000,
    });

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: "quality", passed: false, exitCode: 1 }),
    ]));
  });

  it("fails closed when a required gate has no evidence or only stale evidence", async () => {
    const { evaluateHardGates } = await import("../../src/verification/gates.js");
    const evidence = createEvidence("plan", true, "2026-08-21T00:00:00.000Z");
    const result = evaluateHardGates({
      state: createState([evidence]),
      evidence: [{ gate: "scope", verification: evidence }],
      now: new Date("2026-08-21T00:10:00.000Z"),
      maximumEvidenceAgeMs: 60_000,
    });

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ gate: "scope", passed: false, reason: expect.stringMatching(/stale/i) }),
      expect.objectContaining({ gate: "remote-durability", passed: false, reason: expect.stringMatching(/missing/i) }),
    ]));
  });

  it("fails closed on malformed or contradictory process evidence", async () => {
    const { evaluateHardGates } = await import("../../src/verification/gates.js");
    const now = new Date("2026-08-21T00:10:00.000Z");
    const valid = createEvidence("verify", true, "2026-08-21T00:09:00.000Z");
    const cases: readonly { readonly evidence: VerificationEvidence; readonly reason: RegExp }[] = [
      { evidence: { ...valid, command: "" }, reason: /command/i },
      { evidence: { ...valid, observedOutput: "" }, reason: /output/i },
      { evidence: { ...valid, interpretation: "" }, reason: /interpretation/i },
      { evidence: { ...valid, recordedAt: "not-a-timestamp" }, reason: /timestamp/i },
      { evidence: { ...valid, recordedAt: "2026-08-21T00:10:00.001Z" }, reason: /future/i },
      { evidence: { ...valid, exitCode: null }, reason: /exit code 0/i },
      { evidence: { ...valid, exitCode: 1 }, reason: /exit code 0/i },
      { evidence: { ...valid, passed: false, exitCode: 0 }, reason: /failed.*exit code 0/i },
    ];

    for (const testCase of cases) {
      const result = evaluateHardGates({
        state: createState([testCase.evidence]),
        evidence: [{ gate: "quality", verification: testCase.evidence }],
        now,
        maximumEvidenceAgeMs: 60_000,
      });

      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({ gate: "quality", passed: false, reason: expect.stringMatching(testCase.reason) }),
      ]));
    }
  });

  it("does not let fresh external evidence bypass any unrecorded task-state precondition", async () => {
    const { evaluateHardGates } = await import("../../src/verification/gates.js");
    const evidence = createEvidence("verify", true, "2026-08-21T00:09:00.000Z");
    const gates: readonly GateName[] = [
      "scope",
      "environment-capability",
      "task-state",
      "quality",
      "failure-handling",
      "recovery",
      "handoff",
      "durable-context",
      "critical-unsaved-context",
      "remote-durability",
      "close",
    ];
    const result = evaluateHardGates({
      state: createState([]),
      evidence: gates.map((gate) => ({ gate, verification: evidence })),
      now: new Date("2026-08-21T00:10:00.000Z"),
      maximumEvidenceAgeMs: 60_000,
    });

    expect(result).toHaveLength(gates.length);
    expect(result.every((gate) => !gate.passed)).toBe(true);
  });

  it("enforces represented state preconditions for failure handling, handoff, remote durability, and close", async () => {
    const { evaluateHardGates } = await import("../../src/verification/gates.js");
    const evidence = createEvidence("verify", true, "2026-08-21T00:09:00.000Z");
    const baseState = createState([evidence]);
    const rejectedCloseState: TaskState = {
      ...baseState,
      stage: "close",
      handoffState: "rejected",
      recoveryPoint: baseState.recoveryPoint === null ? null : { ...baseState.recoveryPoint, stage: "close" },
      durableContext: baseState.durableContext === null ? null : { ...baseState.durableContext, stage: "close" },
    };
    const cases: readonly { readonly gate: GateName; readonly state: TaskState; readonly reason: RegExp }[] = [
      { gate: "failure-handling", state: { ...baseState, stage: "debug", role: "debugger" }, reason: /failure handling.*active/i },
      { gate: "handoff", state: { ...baseState, handoffState: "none" }, reason: /handoff.*not.*acknowledged/i },
      { gate: "remote-durability", state: baseState, reason: /remote.*not represented/i },
      { gate: "close", state: baseState, reason: /close stage/i },
      { gate: "close", state: rejectedCloseState, reason: /rejected handoff/i },
    ];

    for (const testCase of cases) {
      const result = evaluateHardGates({
        state: testCase.state,
        evidence: [{ gate: testCase.gate, verification: evidence }],
        now: new Date("2026-08-21T00:10:00.000Z"),
        maximumEvidenceAgeMs: 60_000,
      });

      expect(result).toEqual(expect.arrayContaining([
        expect.objectContaining({ gate: testCase.gate, passed: false, reason: expect.stringMatching(testCase.reason) }),
      ]));
    }
  });
});
