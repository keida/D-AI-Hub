import { redactSensitiveText } from "../adapters/command-runner.js";
import { isSafeManifestId } from "../domain/manifest-id.js";
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

function hasNonEmptyValues(values: readonly string[]): boolean {
  return values.length > 0 && values.every((value) => value.trim().length > 0);
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function evidenceEnvironmentAllowed(state: TaskState, environment: TaskState["environment"]): boolean {
  return environment === state.environment || state.contextManifest.includes(`handoff-source:${environment}`);
}

function recoveryStateFailure(state: TaskState, now: Date): string | null {
  const recoveryPoint = state.recoveryPoint;
  if (recoveryPoint === null) return "No preserved recovery point is recorded";
  if (
    recoveryPoint.taskId !== state.taskId
    || (recoveryPoint.stage !== state.stage && !(state.stage === "close" && recoveryPoint.stage === "verify"))
    || recoveryPoint.environment !== state.environment
    || recoveryPoint.role !== state.role
  ) return "Recovery point identity does not match the current task state";
  if (!hasNonEmptyValues(recoveryPoint.durablePaths) || recoveryPoint.restorationInstructions.trim().length === 0) {
    return "Recovery point paths or restoration instructions are incomplete";
  }
  if (recoveryPoint.snapshotManifestId !== undefined && !isSafeManifestId(recoveryPoint.snapshotManifestId)) return "Recovery point snapshot manifest id is unsafe";
  if (recoveryPoint.durablePaths.some((path) => !/^[a-f0-9]{64}$/i.test(recoveryPoint.hashes[path] ?? ""))) {
    return "Recovery point is missing a valid hash for a durable path";
  }
  const createdAt = Date.parse(recoveryPoint.createdAt);
  if (Number.isNaN(createdAt) || createdAt > now.getTime()) return "Recovery point timestamp is malformed or in the future";
  return null;
}

function durableContextStateFailure(state: TaskState, now: Date, maximumEvidenceAgeMs: number): string | null {
  const manifest = state.durableContext;
  if (manifest === null) return "No durable context manifest is recorded";
  if (
    manifest.taskId !== state.taskId
    || manifest.stage !== state.stage
    || manifest.environment !== state.environment
    || manifest.role !== state.role
  ) return "Durable context identity does not match the current task state";
  if (manifest.manifestId.trim().length === 0 || !hasNonEmptyValues(manifest.durablePaths)) return "Durable context manifest is incomplete";
  if (!isSafeManifestId(manifest.manifestId)) return "Durable context manifest id is unsafe";
  if (manifest.durablePaths.some((path) => !/^[a-f0-9]{64}$/i.test(manifest.hashes[path] ?? ""))) {
    return "Durable context is missing a valid hash for a durable path";
  }
  if (manifest.recoveryPointId !== state.recoveryPoint?.recoveryPointId) return "Durable context does not reference the current recovery point";
  const recordedAt = Date.parse(manifest.recordedAt);
  if (Number.isNaN(recordedAt) || recordedAt > now.getTime()) return "Durable context timestamp is malformed or in the future";
  if (now.getTime() - recordedAt > maximumEvidenceAgeMs) return "Durable context is stale";
  return null;
}

function stateFailure(state: TaskState, gate: GateName, now: Date, maximumEvidenceAgeMs: number): string | null {
  if (gate === "scope") {
    if (!hasNonEmptyValues(state.constraints)) return "Task scope has no complete recorded constraints";
    return null;
  }
  if (gate === "environment-capability") {
    if (!hasNonEmptyValues(state.selectedCapabilities)) return "No selected environment capabilities are recorded";
    if (state.routingDecision === null) return "No routing decision records the selected environment capabilities";
    if (
      state.routingDecision.stage !== state.stage
      || state.routingDecision.environment !== state.environment
      || state.routingDecision.role !== state.role
      || state.routingDecision.selectedModel.trim().length === 0
      || state.routingDecision.reason.trim().length === 0
      || !sameValues(state.routingDecision.selectedCapabilities, state.selectedCapabilities)
    ) return "Routing decision does not match the current task state and capabilities";
    return null;
  }
  if (gate === "task-state") {
    if (state.taskId.trim().length === 0 || state.goal.trim().length === 0) return "Task identity or goal is missing";
    if (!hasNonEmptyValues(state.contextManifest)) return "Task context manifest is missing or incomplete";
    return null;
  }
  if (gate === "quality") return null;
  if (gate === "failure-handling") {
    if (state.stage === "debug" || state.stage === "recover" || state.role === "debugger" || state.role === "recovery-operator") {
      return `Failure handling remains active in task stage ${state.stage}`;
    }
    if (state.verificationEvidence.some((verification) => !verification.passed)) return "Task state contains an unresolved failed verification";
    return null;
  }
  if (gate === "recovery") return recoveryStateFailure(state, now);
  if (gate === "handoff") {
    if (state.handoffState !== "acknowledged" && state.handoffState !== "active" && state.handoffState !== "completed") {
      return `Handoff is not acknowledged by a target environment; current state is ${state.handoffState}`;
    }
    return null;
  }
  if (gate === "durable-context") return durableContextStateFailure(state, now, maximumEvidenceAgeMs);
  if (gate === "critical-unsaved-context") {
    if (state.criticalUnsavedContext.length > 0) return "Critical unsaved context must be preserved before proceeding";
    return null;
  }
  if (gate === "remote-durability") return "Configured remote identity and exact remote commit verification are not represented in TaskState";
  if (state.stage !== "close") return "Task state is not in the close stage";
  if (state.approvalState === "pending" || state.approvalState === "rejected") return `Close approval is ${state.approvalState}`;
  if (state.handoffState === "rejected") return "Close is blocked by a rejected handoff";
  if (state.handoffState === "pending" || state.handoffState === "acknowledged" || state.handoffState === "active") return "Close is blocked by an unresolved handoff";
  const recoveryFailure = recoveryStateFailure(state, now);
  if (recoveryFailure !== null) return recoveryFailure;
  const durableFailure = durableContextStateFailure(state, now, maximumEvidenceAgeMs);
  if (durableFailure !== null) return durableFailure;
  if (state.criticalUnsavedContext.length > 0) return "Close is blocked by critical unsaved context";
  return "Remote durability required for close is not represented in TaskState";
}

function sameEvidence(left: VerificationEvidence, right: VerificationEvidence): boolean {
  return left.evidenceId === right.evidenceId
    && left.stage === right.stage
    && left.environment === right.environment
    && left.role === right.role
    && left.selectedModel === right.selectedModel
    && left.command === right.command
    && left.observedOutput === right.observedOutput
    && left.exitCode === right.exitCode
    && left.interpretation === right.interpretation
    && left.passed === right.passed
    && left.recoveryPointId === right.recoveryPointId
    && left.recordedAt === right.recordedAt;
}

function invalidEvidenceReason(verification: VerificationEvidence, state: TaskState, now: Date, maximumEvidenceAgeMs: number): string | null {
  if (verification.evidenceId.trim().length === 0) return "Evidence id is missing";
  if (verification.selectedModel.trim().length === 0) return "Evidence selected model is missing";
  if (verification.command.trim().length === 0) return "Evidence command is missing";
  if (verification.observedOutput.trim().length === 0) return "Evidence observed output is missing";
  if (verification.interpretation.trim().length === 0) return "Evidence interpretation is missing";
  const recordedAt = Date.parse(verification.recordedAt);
  if (Number.isNaN(recordedAt) || recordedAt > now.getTime()) return "Evidence timestamp is malformed or in the future";
  if (now.getTime() - recordedAt > maximumEvidenceAgeMs) return "Evidence is stale";
  if (!evidenceEnvironmentAllowed(state, verification.environment)) return "Evidence environment does not match the current task state or recorded handoff source";
  if (verification.recoveryPointId !== state.recoveryPoint?.recoveryPointId) return "Evidence recovery point does not match the current task state";
  if (verification.exitCode !== null && !Number.isInteger(verification.exitCode)) return "Evidence exit code must be an integer or null";
  if (verification.passed && verification.exitCode !== 0) return "Passed evidence must report exit code 0";
  if (!verification.passed && verification.exitCode === 0) return "Failed evidence must not report exit code 0";
  if (!verification.passed) return "Evidence reports a failed verification";
  return null;
}

function latestEvidence(gate: GateName, evidence: readonly GateEvidence[]): VerificationEvidence | null {
  const candidates = evidence.filter((entry) => entry.gate === gate).map((entry) => entry.verification);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, candidate) => Date.parse(candidate.recordedAt) > Date.parse(latest.recordedAt) ? candidate : latest);
}

function resultFromEvidence(gate: GateName, verification: VerificationEvidence | null, state: TaskState, now: Date, maximumEvidenceAgeMs: number): GateResult {
  if (verification === null) return { gate, passed: false, observedOutput: "No verification evidence was supplied", exitCode: null, reason: `Missing evidence for ${gate} gate` };
  const requiredStateFailure = stateFailure(state, gate, now, maximumEvidenceAgeMs);
  if (requiredStateFailure !== null) return { gate, passed: false, observedOutput: "State precondition failed", exitCode: null, reason: requiredStateFailure };
  if (!state.verificationEvidence.some((recorded) => sameEvidence(recorded, verification))) {
    return { gate, passed: false, observedOutput: "State precondition failed", exitCode: null, reason: `Evidence for ${gate} gate is not recorded in TaskState` };
  }
  const reason = invalidEvidenceReason(verification, state, now, maximumEvidenceAgeMs);
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
