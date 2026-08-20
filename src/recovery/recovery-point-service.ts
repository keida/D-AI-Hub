import { redactSensitiveText } from "../adapters/command-runner.js";
import { InvalidTaskStateError } from "../domain/errors.js";
import type { DurableContextManifest, Environment, RecoveryPoint, Role, Stage, VerificationEvidence } from "../domain/types.js";

export type RecoveryTrigger = "risky-work" | "handoff" | "recovery" | "close";

export interface RecoverySnapshot {
  readonly head: string;
  readonly branch: string;
  readonly workspacePath: string;
  readonly status: string;
  readonly binaryPatch: string;
  readonly stateManifest: DurableContextManifest;
  readonly verificationResults: readonly VerificationEvidence[];
}

export interface CapturedRecoveryPoint {
  readonly trigger: RecoveryTrigger;
  readonly recoveryPoint: RecoveryPoint;
  readonly snapshot: RecoverySnapshot;
}

export interface RecoveryPointCaptureInput {
  readonly recoveryPointId: string;
  readonly taskId: string;
  readonly trigger: RecoveryTrigger;
  readonly stage: Stage;
  readonly environment: Environment;
  readonly role: Role;
  readonly head: string;
  readonly branch: string;
  readonly workspacePath: string;
  readonly status: string;
  readonly binaryPatch: string;
  readonly stateManifest: DurableContextManifest;
  readonly verificationResults: readonly VerificationEvidence[];
  readonly createdAt: string;
}

const maximumVerificationAgeMs = 5 * 60 * 1_000;

function assertText(value: string, label: string): void {
  if (value.trim().length === 0) throw new InvalidTaskStateError(`${label} must be non-empty`);
}

function assertSafeCapturedValue(value: string, label: string): void {
  if (redactSensitiveText(value) !== value) throw new InvalidTaskStateError(`${label} contains secret-like content and cannot be captured`);
}

function assertVerificationEvidence(
  verification: VerificationEvidence,
  input: RecoveryPointCaptureInput,
  createdAt: number,
): void {
  assertText(verification.evidenceId, "Verification evidence id");
  assertText(verification.selectedModel, "Verification selected model");
  assertText(verification.command, "Verification command");
  assertText(verification.observedOutput, "Verification observed output");
  assertText(verification.interpretation, "Verification interpretation");
  const recordedAt = Date.parse(verification.recordedAt);
  if (Number.isNaN(recordedAt)) throw new InvalidTaskStateError("Verification evidence timestamp must be valid");
  if (recordedAt > createdAt) throw new InvalidTaskStateError("Verification evidence timestamp must not be in the future relative to recovery capture");
  if (createdAt - recordedAt > maximumVerificationAgeMs) throw new InvalidTaskStateError("Verification evidence is stale for recovery capture");
  if (!verification.passed) throw new InvalidTaskStateError("Verification evidence must have passed before recovery capture");
  if (verification.exitCode !== 0) throw new InvalidTaskStateError("Passed verification evidence must have exit code 0");
  if (verification.environment !== input.environment && input.trigger !== "handoff") throw new InvalidTaskStateError("Verification evidence environment must match the recovery environment outside a handoff recovery capture");
  if (verification.recoveryPointId !== input.stateManifest.recoveryPointId) {
    throw new InvalidTaskStateError("Verification evidence recovery point must match the state manifest");
  }
  assertSafeCapturedValue(verification.evidenceId, "Verification evidence id");
  assertSafeCapturedValue(verification.selectedModel, "Verification selected model");
  assertSafeCapturedValue(verification.command, "Verification command");
  assertSafeCapturedValue(verification.observedOutput, "Verification observed output");
  assertSafeCapturedValue(verification.interpretation, "Verification interpretation");
}

function assertVerificationResults(input: RecoveryPointCaptureInput, createdAt: number): void {
  if (input.verificationResults.length === 0) throw new InvalidTaskStateError("At least one verification result is required for recovery capture");
  for (const verification of input.verificationResults) assertVerificationEvidence(verification, input, createdAt);
}

function assertCaptureInput(input: RecoveryPointCaptureInput): void {
  assertText(input.recoveryPointId, "Recovery point id");
  assertText(input.taskId, "Task id");
  assertText(input.branch, "Branch");
  assertText(input.workspacePath, "Workspace path");
  if (!/^[a-f0-9]{40,64}$/i.test(input.head)) throw new InvalidTaskStateError("Recovery HEAD must be a full Git object id");
  const createdAt = Date.parse(input.createdAt);
  if (Number.isNaN(createdAt)) throw new InvalidTaskStateError("Recovery point timestamp must be valid");
  if (input.stateManifest.taskId !== input.taskId) throw new InvalidTaskStateError("Recovery state manifest task id must match the recovery point task id");
  assertSafeCapturedValue(input.status, "Git status");
  assertSafeCapturedValue(input.binaryPatch, "Binary patch");
  assertVerificationResults(input, createdAt);
}

export function createRecoveryPoint(input: RecoveryPointCaptureInput): CapturedRecoveryPoint {
  assertCaptureInput(input);
  const snapshot: RecoverySnapshot = {
    head: input.head,
    branch: input.branch,
    workspacePath: input.workspacePath,
    status: input.status,
    binaryPatch: input.binaryPatch,
    stateManifest: input.stateManifest,
    verificationResults: input.verificationResults.map((verification) => ({ ...verification })),
  };
  return {
    trigger: input.trigger,
    recoveryPoint: {
      recoveryPointId: input.recoveryPointId,
      taskId: input.taskId,
      stage: input.stage,
      environment: input.environment,
      role: input.role,
      durablePaths: input.stateManifest.durablePaths,
      hashes: input.stateManifest.hashes,
      restorationInstructions: "Preserve user work, revert committed changes audibly, restore the captured binary patch, and verify the recovery point.",
      createdAt: input.createdAt,
    },
    snapshot,
  };
}
