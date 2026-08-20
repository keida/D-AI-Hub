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

function assertText(value: string, label: string): void {
  if (value.trim().length === 0) throw new InvalidTaskStateError(`${label} must be non-empty`);
}

function assertSafeCapturedValue(value: string, label: string): void {
  if (redactSensitiveText(value) !== value) throw new InvalidTaskStateError(`${label} contains secret-like content and cannot be captured`);
}

function assertCaptureInput(input: RecoveryPointCaptureInput): void {
  assertText(input.recoveryPointId, "Recovery point id");
  assertText(input.taskId, "Task id");
  assertText(input.branch, "Branch");
  assertText(input.workspacePath, "Workspace path");
  if (!/^[a-f0-9]{40,64}$/i.test(input.head)) throw new InvalidTaskStateError("Recovery HEAD must be a full Git object id");
  if (Number.isNaN(Date.parse(input.createdAt))) throw new InvalidTaskStateError("Recovery point timestamp must be valid");
  if (input.stateManifest.taskId !== input.taskId) throw new InvalidTaskStateError("Recovery state manifest task id must match the recovery point task id");
  assertSafeCapturedValue(input.status, "Git status");
  assertSafeCapturedValue(input.binaryPatch, "Binary patch");
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
    verificationResults: input.verificationResults,
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
