import { redactSensitiveText } from "../adapters/command-runner.js";
import type { TaskState, VerificationEvidence } from "../domain/types.js";

export interface GateResult {
  readonly gate: string;
  readonly passed: boolean;
  readonly observedOutput: string;
  readonly exitCode: number | null;
  readonly reason: string;
}

export type GateName =
  | "scope"
  | "environment-capability"
  | "task-state"
  | "quality"
  | "failure-handling"
  | "recovery"
  | "handoff"
  | "durable-context"
  | "critical-unsaved-context"
  | "remote-durability"
  | "close";

export interface GateEvidence {
  readonly gate: GateName;
  readonly verification: VerificationEvidence;
}

export interface HardGateInput {
  readonly state: TaskState;
  readonly evidence: readonly GateEvidence[];
  readonly now: Date;
  readonly maximumEvidenceAgeMs: number;
}

const gateNames: readonly GateName[] = [
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

function stateFailure(state: TaskState, gate: GateName): string | null {
  if (gate === "scope" && state.constraints.length === 0) return "Task scope has no recorded constraints";
  if (gate === "environment-capability" && state.selectedCapabilities.length === 0) return "No selected environment capabilities are recorded";
  if (gate === "task-state" && (state.taskId.trim().length === 0 || state.goal.trim().length === 0)) return "Task identity or goal is missing";
  if (gate === "recovery" && state.recoveryPoint === null) return "No preserved recovery point is recorded";
  if (gate === "durable-context" && state.durableContext === null) return "No durable context manifest is recorded";
  if (gate === "critical-unsaved-context" && state.criticalUnsavedContext.length > 0) return "Critical unsaved context must be preserved before proceeding";
  if (gate === "close" && state.approvalState === "rejected") return "Close approval was rejected";
  return null;
}

function invalidEvidenceReason(verification: VerificationEvidence, now: Date, maximumEvidenceAgeMs: number): string | null {
  const recordedAt = Date.parse(verification.recordedAt);
  if (Number.isNaN(recordedAt) || recordedAt > now.getTime()) return "Evidence timestamp is malformed or in the future";
  if (now.getTime() - recordedAt > maximumEvidenceAgeMs) return "Evidence is stale";
  if (verification.observedOutput.trim().length === 0 || verification.interpretation.trim().length === 0) return "Evidence output or interpretation is missing";
  if (!verification.passed) return "Evidence reports a failed verification";
  return null;
}

function latestEvidence(gate: GateName, evidence: readonly GateEvidence[]): VerificationEvidence | null {
  const candidates = evidence.filter((entry) => entry.gate === gate).map((entry) => entry.verification);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) => Date.parse(candidate.recordedAt) > Date.parse(latest.recordedAt) ? candidate : latest);
}

function resultFromEvidence(gate: GateName, verification: VerificationEvidence | null, state: TaskState, now: Date, maximumEvidenceAgeMs: number): GateResult {
  const requiredStateFailure = stateFailure(state, gate);
  if (requiredStateFailure !== null) return { gate, passed: false, observedOutput: "State precondition failed", exitCode: null, reason: requiredStateFailure };
  if (verification === null) return { gate, passed: false, observedOutput: "No verification evidence was supplied", exitCode: null, reason: `Missing evidence for ${gate} gate` };
  const reason = invalidEvidenceReason(verification, now, maximumEvidenceAgeMs);
  return {
    gate,
    passed: reason === null,
    observedOutput: redactSensitiveText(verification.observedOutput),
    exitCode: verification.exitCode,
    reason: reason === null ? redactSensitiveText(verification.interpretation) : reason,
  };
}

export function evaluateHardGates(input: HardGateInput): readonly GateResult[] {
  if (!Number.isFinite(input.maximumEvidenceAgeMs) || input.maximumEvidenceAgeMs < 0) {
    throw new RangeError("Maximum evidence age must be a non-negative finite number");
  }
  if (Number.isNaN(input.now.getTime())) {
    throw new RangeError("Gate evaluation time must be valid");
  }
  return gateNames.map((gate) => resultFromEvidence(gate, latestEvidence(gate, input.evidence), input.state, input.now, input.maximumEvidenceAgeMs));
}
