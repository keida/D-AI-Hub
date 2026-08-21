import { redactSensitiveText } from "../adapters/command-runner.js";
import { InvalidTaskStateError } from "../domain/errors.js";
import { assertSafeManifestId, containsSecretShapedValue } from "../domain/manifest-id.js";
import type { DurableContextManifest, Environment, RecoveryPoint, RecoverySnapshot, Role, Stage, VerificationEvidence } from "../domain/types.js";

export type RecoveryTrigger = "risky-work" | "handoff" | "recovery" | "close";

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
  if (redactSensitiveText(value) !== value || containsSecretShapedValue(value)) {
    throw new InvalidTaskStateError(`${label} contains secret-like content and cannot be captured`);
  }
}

function assertDurableArtifacts(manifest: DurableContextManifest): void {
  if (manifest.durablePaths.length === 0) throw new InvalidTaskStateError("Recovery durable paths must be non-empty");
  if (manifest.durablePaths.some((path) => path.trim().length === 0)) {
    throw new InvalidTaskStateError("Recovery durable paths must be non-empty");
  }
  if (new Set(manifest.durablePaths).size !== manifest.durablePaths.length) {
    throw new InvalidTaskStateError("Recovery durable paths must not contain duplicates");
  }
  const hashEntries = Object.entries(manifest.hashes);
  const durablePathSet = new Set(manifest.durablePaths);
  if (hashEntries.length !== manifest.durablePaths.length || manifest.durablePaths.some((path) => manifest.hashes[path] === undefined) || hashEntries.some(([path]) => !durablePathSet.has(path))) {
    throw new InvalidTaskStateError("Recovery hash keys must exactly match durable paths");
  }
  for (const [path, hash] of hashEntries) {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new InvalidTaskStateError(`Recovery hash for ${path} must be a SHA-256 hash`);
  }
}

function assertSafeCapturedFields(input: RecoveryPointCaptureInput): void {
  const fields: readonly (readonly [string, string])[] = [
    ["Recovery point id", input.recoveryPointId],
    ["Task id", input.taskId],
    ["Recovery trigger", input.trigger],
    ["Recovery stage", input.stage],
    ["Recovery environment", input.environment],
    ["Recovery role", input.role],
    ["Recovery HEAD", input.head],
    ["Recovery branch", input.branch],
    ["Recovery workspace path", input.workspacePath],
    ["Git status", input.status],
    ["Binary patch", input.binaryPatch],
    ["Recovery created-at timestamp", input.createdAt],
    ["Recovery snapshot manifest id", input.stateManifest.manifestId],
    ["Recovery snapshot task id", input.stateManifest.taskId],
    ["Recovery snapshot stage", input.stateManifest.stage],
    ["Recovery snapshot environment", input.stateManifest.environment],
    ["Recovery snapshot role", input.stateManifest.role],
    ["Recovery snapshot recorded-at timestamp", input.stateManifest.recordedAt],
  ];
  for (const [label, value] of fields) assertSafeCapturedValue(value, label);
  for (const path of input.stateManifest.durablePaths) assertSafeCapturedValue(path, "Recovery durable path");
  if (input.stateManifest.recoveryPointId !== null) assertSafeCapturedValue(input.stateManifest.recoveryPointId, "Recovery snapshot recovery point id");
  for (const [path, hash] of Object.entries(input.stateManifest.hashes)) {
    assertSafeCapturedValue(path, "Recovery hash path");
    assertSafeCapturedValue(hash, `Recovery hash for ${path}`);
  }
  for (const verification of input.verificationResults) {
    assertSafeCapturedValue(verification.evidenceId, "Verification evidence id");
    assertSafeCapturedValue(verification.stage, "Verification stage");
    assertSafeCapturedValue(verification.environment, "Verification environment");
    assertSafeCapturedValue(verification.role, "Verification role");
    assertSafeCapturedValue(verification.selectedModel, "Verification selected model");
    assertSafeCapturedValue(verification.command, "Verification command");
    assertSafeCapturedValue(verification.observedOutput, "Verification observed output");
    assertSafeCapturedValue(verification.interpretation, "Verification interpretation");
    if (verification.recoveryPointId !== null) assertSafeCapturedValue(verification.recoveryPointId, "Verification recovery point id");
    assertSafeCapturedValue(verification.recordedAt, "Verification recorded-at timestamp");
  }
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
  assertSafeCapturedFields(input);
  assertSafeManifestId(input.stateManifest.manifestId, "Recovery snapshot manifest id");
  assertDurableArtifacts(input.stateManifest);
  assertSafeCapturedValue(input.status, "Git status");
  assertSafeCapturedValue(input.binaryPatch, "Binary patch");
  assertVerificationResults(input, createdAt);
}

export function createRecoveryPoint(input: RecoveryPointCaptureInput): CapturedRecoveryPoint {
  assertCaptureInput(input);
  const snapshotPaths = [...input.stateManifest.durablePaths];
  const snapshotHashes: Record<string, string> = {};
  const durableArtifacts: Record<string, string> = {};
  for (const path of snapshotPaths) {
    const hash = input.stateManifest.hashes[path];
    if (hash === undefined) throw new InvalidTaskStateError(`Recovery snapshot hash is missing for ${path}`);
    snapshotHashes[path] = hash;
    durableArtifacts[path] = hash;
  }
  const snapshot: RecoverySnapshot = {
    head: input.head,
    branch: input.branch,
    workspacePath: input.workspacePath,
    status: input.status,
    binaryPatch: input.binaryPatch,
    stateManifest: {
      ...input.stateManifest,
      durablePaths: [...input.stateManifest.durablePaths],
      hashes: { ...input.stateManifest.hashes },
    },
    verificationResults: input.verificationResults.map((verification) => ({ ...verification })),
    durableArtifacts,
  };
  return {
    trigger: input.trigger,
    recoveryPoint: {
      recoveryPointId: input.recoveryPointId,
      taskId: input.taskId,
      stage: input.stage,
      environment: input.environment,
      role: input.role,
      durablePaths: snapshotPaths,
      hashes: snapshotHashes,
      restorationInstructions: "Preserve user work, revert committed changes audibly, restore the captured binary patch, and verify the recovery point.",
      createdAt: input.createdAt,
      snapshotManifestId: input.stateManifest.manifestId,
    },
    snapshot,
  };
}
