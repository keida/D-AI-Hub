import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { InvalidTaskStateError, TaskOwnershipError } from "../domain/errors.js";
import { assertSafeManifestId, containsSecretShapedValue, isSafeManifestId } from "../domain/manifest-id.js";
import type { CloseCandidate, DebugSession, DurableContextManifest, Environment, TaskState } from "../domain/types.js";
import type {
  DurableContextStore,
  TaskOwnershipGuard,
  TaskOwnershipLease,
  TaskOwnershipTransfer,
  TaskOwnershipTransition,
  TaskOwnershipTransitionAuthorizer,
  TaskStateWriteAuthorization,
} from "./durable-context-store.js";

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const credentialFieldPattern = /(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?|credential|cookie|password|private[_-]?key|secret|session[_-]?token)/i;
export const FILE_DURABLE_CONTEXT_LEASE_MS = 30_000;
const ownershipDirectoryName = "ownership";
const ownershipOwnerFile = "owner.json";
const ownershipLeaseFile = "lease";
const ownershipReleasedFile = "released";
const ownershipTransferFile = "transfer.json";
const activeDirectoryName = "active";

const stageSchema = z.enum([
  "bootstrap",
  "route",
  "plan",
  "execute",
  "inspect",
  "verify",
  "debug",
  "recover",
  "handoff",
  "close",
]);
const environmentSchema = z.enum(["chat", "work", "codex"]);
const roleSchema = z.enum([
  "analyst",
  "planner",
  "implementer",
  "evidence-collector",
  "reviewer",
  "debugger",
  "recovery-operator",
]);
const debugSessionSchema = z
  .object({
    phase: z.enum(["reproduce", "capture", "isolate", "hypothesize", "change", "reverify", "regress", "stop"]),
    originalFailure: z.string().min(1),
    hypothesis: z.string().min(1).nullable(),
    preservedRecoveryPointId: z.string().min(1),
  })
  .strict();
const safeManifestIdSchema = z.string().refine(isSafeManifestId, "must be a UUID or manifest-UUID");
const ownershipRecordSchema = z.object({
  taskId: z.string().min(1),
  environment: environmentSchema,
  ownerToken: z.string().uuid(),
}).strict();
const verificationEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    stage: stageSchema,
    environment: environmentSchema,
    role: roleSchema,
    selectedModel: z.string(),
    command: z.string(),
    observedOutput: z.string(),
    exitCode: z.number().int().nullable(),
    interpretation: z.string(),
    passed: z.boolean(),
    recoveryPointId: z.string().min(1).nullable(),
    recordedAt: z.string().datetime(),
  })
  .strict();
const manifestSchema = z
  .object({
    manifestId: safeManifestIdSchema,
    taskId: z.string().min(1),
    stage: stageSchema,
    environment: environmentSchema,
    role: roleSchema,
    durablePaths: z.array(z.string().min(1)),
    hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    recoveryPointId: z.string().min(1).nullable(),
    recordedAt: z.string().datetime(),
  })
  .strict();
const recoverySnapshotSchema = z
  .object({
    head: z.string(),
    branch: z.string(),
    workspacePath: z.string(),
    status: z.string(),
    binaryPatch: z.string(),
    stateManifest: manifestSchema,
    verificationResults: z.array(verificationEvidenceSchema),
    durableArtifacts: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
  })
  .strict();
const rollbackAuditSchema = z.object({
  archiveId: z.string().min(1),
  patchDigest: z.string().regex(/^[a-f0-9]{64}$/),
  actions: z.array(z.object({ command: z.string().min(1), arguments: z.array(z.string()), stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable() }).strict()),
  verification: z.object({ passed: z.boolean(), observedOutput: z.string(), reason: z.string() }).strict(),
  recordedAt: z.string().datetime(),
}).strict();
const ownershipTransferSchema = z.object({
  taskId: z.string().min(1),
  ownerToken: z.string().uuid(),
  sourceEnvironment: environmentSchema,
  targetEnvironment: environmentSchema,
}).strict();
const recoveryPointSchema = z
  .object({
    recoveryPointId: z.string().min(1),
    taskId: z.string().min(1),
    stage: stageSchema,
    environment: environmentSchema,
    role: roleSchema,
    durablePaths: z.array(z.string().min(1)),
    hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    restorationInstructions: z.string(),
    createdAt: z.string().datetime(),
    snapshotManifestId: safeManifestIdSchema.optional(),
  })
  .strict();
const closeCandidateSchema = z
  .object({
    taskId: z.string().min(1),
    durableContext: manifestSchema,
    contextManifest: z.array(z.string()),
    repositoryPath: z.string().min(1),
    remote: z.string().min(1),
    ref: z.string().min(1),
    commitSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    criticalUnsavedContext: z.array(z.string()),
    recordedAt: z.string().datetime(),
  })
  .strict();
const persistedCloseCandidateSchema = z
  .object({
    candidate: closeCandidateSchema,
    hash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const activePointerSchema = z
  .object({
    manifestId: safeManifestIdSchema,
    ownershipGeneration: z.string().regex(/^[1-9][0-9]*$/),
  })
  .strict();
const taskStateSchema = z
  .object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    constraints: z.array(z.string()),
    environment: environmentSchema,
    stage: stageSchema,
    role: roleSchema,
    routingDecision: z
      .object({
        stage: stageSchema,
        requestedStage: stageSchema.optional(),
        environment: environmentSchema,
        role: roleSchema,
        selectedModel: z.string(),
        selectedCapabilities: z.array(z.string()),
        reason: z.string(),
        overrideSource: z.enum(["default", "user"]),
      })
      .strict()
      .nullable(),
    selectedCapabilities: z.array(z.string()),
    contextManifest: z.array(z.string()),
    handoffState: z.enum(["none", "pending", "acknowledged", "active", "completed", "rejected"]),
    verificationEvidence: z.array(verificationEvidenceSchema),
    verificationHistory: z.array(verificationEvidenceSchema).optional(),
    recoveryPoint: recoveryPointSchema.nullable(),
    recoverySnapshot: recoverySnapshotSchema.nullable().optional(),
    rollbackAudit: rollbackAuditSchema.nullable().optional(),
    approvalState: z.enum(["not-required", "pending", "approved", "rejected"]),
    criticalUnsavedContext: z.array(z.string()),
    durableContext: manifestSchema.nullable(),
    closeCandidate: closeCandidateSchema.optional(),
    debugSession: debugSessionSchema.nullable().optional(),
  })
  .strict();
const contextRecordSchema = z
  .object({
    goal: z.string().min(1),
    constraints: z.array(z.string()),
    contextManifest: z.array(z.string()),
  })
  .strict();
const evidenceRecordSchema = z.object({ verificationEvidence: z.array(verificationEvidenceSchema), verificationHistory: z.array(verificationEvidenceSchema).optional() }).strict();
const approvalRecordSchema = z
  .object({ approvalState: z.enum(["not-required", "pending", "approved", "rejected"]), criticalUnsavedContext: z.array(z.string()) })
  .strict();
const handoffRecordSchema = z
  .object({ handoffState: z.enum(["none", "pending", "acknowledged", "active", "completed", "rejected"]) })
  .strict();
const recoveryRecordSchema = z
  .object({
    recoveryPoint: recoveryPointSchema.nullable(),
    recoverySnapshot: recoverySnapshotSchema.nullable().optional(),
    rollbackAudit: rollbackAuditSchema.nullable().optional(),
  })
  .strict();

interface SnapshotPaths {
  readonly taskRoot: string;
  readonly state: string;
  readonly context: string;
  readonly evidence: string;
  readonly approval: string;
  readonly handoff: string;
  readonly recovery: string;
  readonly manifest: string;
  readonly activeRoot: string;
  readonly closeCandidate: string;
}

interface FileTaskOwnershipLease extends TaskOwnershipLease {
  readonly generationPath: string;
  readonly ownershipRoot: string;
}

interface FileTaskOwnershipGeneration {
  readonly generation: bigint;
  readonly generationPath: string;
}

interface ActivePointer {
  readonly manifestId: string;
  readonly ownershipGeneration: bigint;
}

function createHashForContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isTaskOwnershipTransition(authorization: TaskStateWriteAuthorization): authorization is TaskOwnershipTransition {
  return "targetEnvironment" in authorization;
}

function serialize(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertTaskId(taskId: string): void {
  if (!taskIdPattern.test(taskId)) {
    throw new InvalidTaskStateError(`Invalid task id: ${taskId}`);
  }
}

function assertNoCredentialLikeFields(value: unknown, targetPath: string, fieldPath: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialLikeFields(item, targetPath, `${fieldPath}[${index}]`));
    return;
  }

  if (typeof value === "string") {
    if (containsSecretShapedValue(value)) {
      throw new InvalidTaskStateError(`Secret-like value rejected for target path ${targetPath}: durable context must be redacted`);
    }
    return;
  }
  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [fieldName, fieldValue] of Object.entries(value)) {
    const nestedFieldPath = `${fieldPath}.${fieldName}`;
    if (credentialFieldPattern.test(fieldName)) {
      throw new InvalidTaskStateError(
        `Credential-like field ${nestedFieldPath} rejected for target path ${targetPath}: durable context must be redacted`,
      );
    }
    assertNoCredentialLikeFields(fieldValue, targetPath, nestedFieldPath);
  }
}

function parseTaskState(value: unknown, targetPath: string): TaskState {
  const result = taskStateSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new InvalidTaskStateError(`Invalid task state at ${targetPath}: ${reason}`);
  }
  return result.data;
}

function parseManifest(value: unknown, taskId: string, targetPath: string): DurableContextManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new InvalidTaskStateError(`Invalid durable manifest for task ${taskId} at ${targetPath}: ${reason}`);
  }
  return result.data;
}

function parseCloseCandidate(value: unknown, taskId: string, targetPath: string): CloseCandidate {
  const result = closeCandidateSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new InvalidTaskStateError(`Invalid durable close candidate for task ${taskId} at ${targetPath}: ${reason}`);
  }
  return result.data;
}

function parseCompanionRecord(value: unknown, taskId: string, targetPath: string, schema: z.ZodType): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new InvalidTaskStateError(`Invalid durable companion record for task ${taskId} at ${targetPath}: ${reason}`);
  }
}

function parseJson(content: string, taskId: string, targetPath: string): unknown {
  try {
    return JSON.parse(content);
  } catch (error: unknown) {
    throw new InvalidTaskStateError(`Invalid JSON for task ${taskId} at ${targetPath}: ${describeError(error)}`);
  }
}

function createSnapshotPaths(rootPath: string, taskId: string): SnapshotPaths {
  const taskRoot = join(rootPath, taskId);
  return {
    taskRoot,
    state: join(taskRoot, "state.json"),
    context: join(taskRoot, "context.json"),
    evidence: join(taskRoot, "evidence.json"),
    approval: join(taskRoot, "approval.json"),
    handoff: join(taskRoot, "handoff.json"),
    recovery: join(taskRoot, "recovery.json"),
    manifest: join(taskRoot, "manifest.json"),
    activeRoot: join(taskRoot, activeDirectoryName),
    closeCandidate: join(taskRoot, "close-candidate.json"),
  };
}

function generationRoot(paths: SnapshotPaths, manifestId: string): string {
  return join(paths.taskRoot, "generations", manifestId);
}

function generationPath(paths: SnapshotPaths, manifestId: string, activePath: string): string {
  return join(generationRoot(paths, manifestId), basename(activePath));
}

function activePointerPath(paths: SnapshotPaths, generation: bigint): string {
  return join(paths.activeRoot, `${generation.toString().padStart(20, "0")}.json`);
}

function allDurablePaths(paths: SnapshotPaths): readonly string[] {
  return [paths.context, paths.evidence, paths.approval, paths.handoff, paths.recovery, paths.state, paths.manifest];
}

async function hasRemainingSnapshotArtifacts(paths: SnapshotPaths): Promise<boolean> {
  for (const artifactPath of allDurablePaths(paths)) {
    if (artifactPath === paths.state) {
      continue;
    }
    try {
      await lstat(artifactPath);
      return true;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) {
        throw new InvalidTaskStateError(`Unable to inspect durable snapshot artifact at ${artifactPath}: ${describeError(error)}`);
      }
    }
  }
  return false;
}

function createCanonicalManifestContent(manifest: DurableContextManifest): string {
  return serialize({ ...manifest, hashes: {} });
}

function createCanonicalStateContent(state: TaskState): string {
  if (state.durableContext === null) {
    throw new InvalidTaskStateError(`Cannot hash durable task state ${state.taskId}: durable context is missing`);
  }
  return serialize({ ...state, durableContext: { ...state.durableContext, hashes: {} } });
}

function createCanonicalCloseCandidateContent(candidate: CloseCandidate): string {
  return serialize(candidate);
}

function throwIntegrityError(
  taskId: string,
  targetPath: string,
  expectedHash: string,
  observedHash: string,
  reason: string,
): never {
  throw new InvalidTaskStateError(
    `Durable integrity check failed for task ${taskId} at ${targetPath}: ${reason}; expected hash ${expectedHash}; observed hash ${observedHash}`,
  );
}

function assertManifestContract(manifest: DurableContextManifest, taskId: string, paths: SnapshotPaths): void {
  if (manifest.taskId !== taskId) {
    throwIntegrityError(taskId, paths.manifest, taskId, manifest.taskId, "manifest task id does not match requested task");
  }
  const requiredPaths = allDurablePaths(paths);
  const durablePaths = new Set(manifest.durablePaths);
  const hashPaths = new Set(Object.keys(manifest.hashes));
  const hasExactDurablePaths = durablePaths.size === requiredPaths.length && requiredPaths.every((path) => durablePaths.has(path));
  const hasExactHashPaths = hashPaths.size === requiredPaths.length && requiredPaths.every((path) => hashPaths.has(path));
  if (!hasExactDurablePaths || !hasExactHashPaths) {
    throwIntegrityError(
      taskId,
      paths.manifest,
      requiredPaths.join(","),
      `${manifest.durablePaths.join(",")} | ${Object.keys(manifest.hashes).join(",")}`,
      "manifest does not declare exactly the required durable paths and hashes",
    );
  }
}

async function readRequiredContent(taskId: string, targetPath: string, expectedHash: string): Promise<string> {
  try {
    return await readFile(targetPath, "utf8");
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      throwIntegrityError(taskId, targetPath, expectedHash, "missing", "required durable artifact is missing");
    }
    throw new InvalidTaskStateError(`Unable to read durable artifact for task ${taskId} at ${targetPath}: ${describeError(error)}`);
  }
}

function assertRawHash(taskId: string, targetPath: string, content: string, expectedHash: string): void {
  const observedHash = createHashForContent(content);
  if (observedHash !== expectedHash) {
    throwIntegrityError(taskId, targetPath, expectedHash, observedHash, "content hash mismatch");
  }
}

async function writeAtomically(targetPath: string, content: string): Promise<void> {
  const temporaryPath = join(
    resolve(targetPath, ".."),
    `.${basename(targetPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function writeGenerationAtomically(paths: SnapshotPaths, manifestId: string, contents: ReadonlyMap<string, string>): Promise<void> {
  const generationsRoot = join(paths.taskRoot, "generations");
  await mkdir(generationsRoot, { recursive: true });
  const temporaryRoot = join(generationsRoot, `.${manifestId}.${randomUUID()}.tmp`);
  const finalRoot = generationRoot(paths, manifestId);
  try {
    await mkdir(temporaryRoot, { recursive: true });
    for (const [path, content] of contents) {
      await writeFile(join(temporaryRoot, basename(path)), content, { encoding: "utf8", flag: "wx" });
    }
    await rename(temporaryRoot, finalRoot);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function loadActivePointer(paths: SnapshotPaths, taskId: string): Promise<ActivePointer | null> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(paths.activeRoot, { withFileTypes: true });
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw new InvalidTaskStateError(`Unable to inspect active durable pointers for task ${taskId}: ${describeError(error)}`);
  }
  const pointerEntries = entries
    .filter((entry) => entry.isFile() && /^[0-9]{20}\.json$/.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name));
  const entry = pointerEntries[0];
  if (entry === undefined) return null;
  const path = join(paths.activeRoot, entry.name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    throw new InvalidTaskStateError(`Invalid active durable pointer for task ${taskId} at ${path}: ${describeError(error)}`);
  }
  const result = activePointerSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new InvalidTaskStateError(`Invalid active durable pointer for task ${taskId} at ${path}: ${reason}`);
  }
  return {
    manifestId: result.data.manifestId,
    ownershipGeneration: BigInt(result.data.ownershipGeneration),
  };
}

async function publishActivePointer(paths: SnapshotPaths, manifestId: string, ownershipGeneration: bigint): Promise<void> {
  await mkdir(paths.activeRoot, { recursive: true });
  await writeAtomically(
    activePointerPath(paths, ownershipGeneration),
    serialize({ manifestId, ownershipGeneration: ownershipGeneration.toString() }),
  );
}

export class FileDurableContextStore implements DurableContextStore {
  private readonly rootPath: string;
  private readonly saveLocks = new Map<string, Promise<void>>();
  private readonly issuedTransitions = new WeakSet<TaskOwnershipTransition>();

  public constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  public async load(taskId: string): Promise<TaskState | null> {
    assertTaskId(taskId);
    const paths = createSnapshotPaths(this.rootPath, taskId);
    const activePointer = await loadActivePointer(paths, taskId);
    let stateContent: string;
    try {
      stateContent = activePointer === null
        ? await readFile(paths.state, "utf8")
        : await readRequiredContent(taskId, generationPath(paths, activePointer.manifestId, paths.state), "active generation state");
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        if (await hasRemainingSnapshotArtifacts(paths)) {
          throw new InvalidTaskStateError(
            `Durable task state is missing for task ${taskId} at ${paths.state} while snapshot artifacts remain in ${paths.taskRoot}`,
          );
        }
        return null;
      }
      throw new InvalidTaskStateError(`Unable to read durable task state at ${paths.state}: ${describeError(error)}`);
    }

    const manifestContent = activePointer === null
      ? await readRequiredContent(taskId, paths.manifest, "declared SHA-256")
      : await readRequiredContent(taskId, generationPath(paths, activePointer.manifestId, paths.manifest), "active generation manifest");
    const manifest = parseManifest(parseJson(manifestContent, taskId, paths.manifest), taskId, paths.manifest);
    assertSafeManifestId(manifest.manifestId, "Durable manifest id");
    assertManifestContract(manifest, taskId, paths);
    const manifestHash = manifest.hashes[paths.manifest];
    const stateHash = manifest.hashes[paths.state];
    if (manifestHash === undefined || stateHash === undefined) {
      throw new InvalidTaskStateError(`Manifest contract for task ${taskId} is missing required state integrity hashes`);
    }
    const observedManifestHash = createHashForContent(createCanonicalManifestContent(manifest));
    if (observedManifestHash !== manifestHash) {
      throwIntegrityError(taskId, paths.manifest, manifestHash, observedManifestHash, "canonical manifest hash mismatch");
    }

    const generationManifestPath = generationPath(paths, manifest.manifestId, paths.manifest);
    const generationManifestContent = await readRequiredContent(taskId, generationManifestPath, manifestHash);
    const generationManifest = parseManifest(parseJson(generationManifestContent, taskId, generationManifestPath), taskId, generationManifestPath);
    const observedGenerationManifestHash = createHashForContent(createCanonicalManifestContent(generationManifest));
    if (observedGenerationManifestHash !== manifestHash) {
      throwIntegrityError(taskId, generationManifestPath, manifestHash, observedGenerationManifestHash, "canonical generation manifest hash mismatch");
    }
    if (JSON.stringify(generationManifest) !== JSON.stringify(manifest)) {
      throwIntegrityError(taskId, generationManifestPath, manifestHash, "manifest identity mismatch", "generation manifest does not match active manifest");
    }
    const activeState = parseTaskState(parseJson(stateContent, taskId, paths.state), paths.state);
    assertNoCredentialLikeFields(activeState, paths.state, "state");
    const observedActiveStateHash = createHashForContent(createCanonicalStateContent(activeState));
    if (observedActiveStateHash !== stateHash) {
      throwIntegrityError(taskId, paths.state, stateHash, observedActiveStateHash, "canonical state hash mismatch");
    }
    const generationStatePath = generationPath(paths, manifest.manifestId, paths.state);
    const generationStateContent = await readRequiredContent(taskId, generationStatePath, stateHash);
    const state = parseTaskState(parseJson(generationStateContent, taskId, generationStatePath), generationStatePath);
    assertNoCredentialLikeFields(state, paths.state, "state");
    const observedStateHash = createHashForContent(createCanonicalStateContent(state));
    if (observedStateHash !== stateHash) {
      throwIntegrityError(taskId, generationStatePath, stateHash, observedStateHash, "canonical state hash mismatch");
    }
    const companionRecords: readonly [string, z.ZodType][] = [
      [paths.context, contextRecordSchema],
      [paths.evidence, evidenceRecordSchema],
      [paths.approval, approvalRecordSchema],
      [paths.handoff, handoffRecordSchema],
      [paths.recovery, recoveryRecordSchema],
    ];
    for (const [targetPath, schema] of companionRecords) {
      const expectedHash = manifest.hashes[targetPath];
      if (expectedHash === undefined) {
        throw new InvalidTaskStateError(`Manifest contract for task ${taskId} is missing a hash for ${targetPath}`);
      }
      const content = await readRequiredContent(taskId, targetPath, expectedHash);
      assertRawHash(taskId, targetPath, content, expectedHash);
      parseCompanionRecord(parseJson(content, taskId, targetPath), taskId, targetPath, schema);
      const generationTargetPath = generationPath(paths, manifest.manifestId, targetPath);
      const generationContent = await readRequiredContent(taskId, generationTargetPath, expectedHash);
      assertRawHash(taskId, generationTargetPath, generationContent, expectedHash);
      parseCompanionRecord(parseJson(generationContent, taskId, generationTargetPath), taskId, generationTargetPath, schema);
    }

    if (state.durableContext === null || JSON.stringify(state.durableContext) !== JSON.stringify(manifest)) {
      throwIntegrityError(taskId, paths.state, manifestHash, "state manifest mismatch", "state does not contain the persisted manifest");
    }
    return state;
  }

  public async save(state: TaskState, authorization?: TaskStateWriteAuthorization): Promise<DurableContextManifest> {
    const previous = this.saveLocks.get(state.taskId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.saveLocks.set(state.taskId, current);
    await previous;
    try {
      return await this.saveInternal(state, authorization);
    } finally {
      release();
      if (this.saveLocks.get(state.taskId) === current) this.saveLocks.delete(state.taskId);
    }
  }

  private async saveInternal(state: TaskState, authorization?: TaskStateWriteAuthorization): Promise<DurableContextManifest> {
    assertTaskId(state.taskId);
    const paths = createSnapshotPaths(this.rootPath, state.taskId);
    let transition: TaskOwnershipTransition | null = null;
    let ownedLease: TaskOwnershipLease | undefined;
    if (authorization !== undefined) {
      if (isTaskOwnershipTransition(authorization)) {
        transition = authorization;
        if (!this.issuedTransitions.has(transition)) {
          throw new TaskOwnershipError(`Durable ownership transition is not store-issued for task ${state.taskId}`);
        }
        ownedLease = authorization.lease;
      } else {
        ownedLease = authorization;
      }
    }
    if (ownedLease !== undefined) {
      if (ownedLease.taskId !== state.taskId) {
        throw new TaskOwnershipError(`Durable ownership task mismatch for task ${state.taskId}`);
      }
      if (transition !== null && transition.targetEnvironment !== state.environment) {
        throw new TaskOwnershipError(`Durable ownership transition target mismatch for task ${state.taskId}`);
      }
      if (transition === null && ownedLease.environment !== state.environment) {
        throw new TaskOwnershipError(`Durable ownership environment mismatch for task ${state.taskId}`);
      }
      await this.assertCurrentTaskOwnership(ownedLease);
    }
    assertNoCredentialLikeFields(state, paths.state, "state");
    const validatedState = parseTaskState(state, paths.state);
    await mkdir(paths.taskRoot, { recursive: true });

    const contents = new Map<string, string>([
      [paths.context, serialize({ goal: validatedState.goal, constraints: validatedState.constraints, contextManifest: validatedState.contextManifest })],
      [paths.evidence, serialize({ verificationEvidence: validatedState.verificationEvidence, ...(validatedState.verificationHistory === undefined ? {} : { verificationHistory: validatedState.verificationHistory }) })],
      [paths.approval, serialize({ approvalState: validatedState.approvalState, criticalUnsavedContext: validatedState.criticalUnsavedContext })],
      [paths.handoff, serialize({ handoffState: validatedState.handoffState })],
      [paths.recovery, serialize({ recoveryPoint: validatedState.recoveryPoint, recoverySnapshot: validatedState.recoverySnapshot ?? null, rollbackAudit: validatedState.rollbackAudit ?? null })],
    ]);
    const manifest: DurableContextManifest = {
      manifestId: randomUUID(),
      taskId: validatedState.taskId,
      stage: validatedState.stage,
      environment: validatedState.environment,
      role: validatedState.role,
      durablePaths: allDurablePaths(paths),
      hashes: {},
      recoveryPointId: validatedState.recoveryPoint?.recoveryPointId ?? null,
      recordedAt: new Date().toISOString(),
    };
    assertSafeManifestId(manifest.manifestId, "Durable manifest id");
    const persistedState = { ...validatedState, durableContext: manifest };
    const hashes: Record<string, string> = {};
    for (const [path, content] of contents) {
      hashes[path] = createHashForContent(content);
    }
    hashes[paths.state] = createHashForContent(createCanonicalStateContent(persistedState));
    hashes[paths.manifest] = createHashForContent(createCanonicalManifestContent(manifest));
    const persistedManifest: DurableContextManifest = { ...manifest, hashes };
    const stateContent = serialize({ ...persistedState, durableContext: persistedManifest });
    const manifestContent = serialize(persistedManifest);
    const generationContents = new Map<string, string>([
      ...contents,
      [paths.manifest, manifestContent],
      [paths.state, stateContent],
    ]);

    if (ownedLease !== undefined) await this.assertCurrentTaskOwnership(ownedLease);
    await writeGenerationAtomically(paths, manifest.manifestId, generationContents);
    for (const [path, content] of contents) {
      if (ownedLease !== undefined) await this.assertCurrentTaskOwnership(ownedLease);
      await writeAtomically(path, content);
    }
    if (ownedLease !== undefined) await this.assertCurrentTaskOwnership(ownedLease);
    await writeAtomically(paths.manifest, manifestContent);
    if (ownedLease !== undefined) await this.assertCurrentTaskOwnership(ownedLease);
    await writeAtomically(paths.state, stateContent);
    if (ownedLease !== undefined) await this.assertCurrentTaskOwnership(ownedLease);
    if (ownedLease !== undefined) await publishActivePointer(paths, manifest.manifestId, ownedLease.generation);
    return persistedManifest;
  }

  public async verifyDurableSnapshot(manifest: DurableContextManifest): Promise<void> {
    assertTaskId(manifest.taskId);
    const paths = createSnapshotPaths(this.rootPath, manifest.taskId);
    const expectedManifestHash = manifest.hashes[paths.manifest];
    if (expectedManifestHash === undefined) throw new InvalidTaskStateError(`Durable snapshot is missing its manifest hash for task ${manifest.taskId}`);
    const manifestContent = await readRequiredContent(manifest.taskId, paths.manifest, expectedManifestHash);
    const persistedManifest = parseManifest(parseJson(manifestContent, manifest.taskId, paths.manifest), manifest.taskId, paths.manifest);
    const observedManifestHash = createHashForContent(createCanonicalManifestContent(persistedManifest));
    if (observedManifestHash !== expectedManifestHash || JSON.stringify(persistedManifest) !== JSON.stringify(manifest)) {
      throwIntegrityError(manifest.taskId, paths.manifest, expectedManifestHash, observedManifestHash, "durable manifest does not match submitted snapshot");
    }
    for (const targetPath of manifest.durablePaths) {
      const expectedHash = manifest.hashes[targetPath];
      if (expectedHash === undefined) throw new InvalidTaskStateError(`Durable snapshot is missing a hash for ${targetPath}`);
      const content = await readRequiredContent(manifest.taskId, targetPath, expectedHash);
      if (targetPath === paths.manifest) continue;
      if (targetPath === paths.state) {
        const persistedState = parseTaskState(parseJson(content, manifest.taskId, targetPath), targetPath);
        const observedStateHash = createHashForContent(createCanonicalStateContent(persistedState));
        if (observedStateHash !== expectedHash) throwIntegrityError(manifest.taskId, targetPath, expectedHash, observedStateHash, "canonical state hash mismatch");
        continue;
      }
      assertRawHash(manifest.taskId, targetPath, content, expectedHash);
    }
  }

  public async saveCloseCandidate(candidate: CloseCandidate, lease?: TaskOwnershipLease): Promise<void> {
    assertTaskId(candidate.taskId);
    if (lease === undefined) throw new TaskOwnershipError(`Durable close candidate write requires ownership for task ${candidate.taskId}`);
    if (lease.taskId !== candidate.taskId || lease.environment !== candidate.durableContext.environment) {
      throw new TaskOwnershipError(`Durable close candidate ownership mismatch for task ${candidate.taskId}`);
    }
    await this.assertCurrentTaskOwnership(lease);
    const paths = createSnapshotPaths(this.rootPath, candidate.taskId);
    assertNoCredentialLikeFields(candidate, paths.closeCandidate, "closeCandidate");
    const validatedCandidate = parseCloseCandidate(candidate, candidate.taskId, paths.closeCandidate);
    assertSafeManifestId(validatedCandidate.durableContext.manifestId, "Close candidate durable manifest id");
    if (validatedCandidate.durableContext.taskId !== validatedCandidate.taskId) {
      throw new InvalidTaskStateError(`Close candidate durable manifest task mismatch for task ${validatedCandidate.taskId}`);
    }
    await mkdir(paths.taskRoot, { recursive: true });
    const candidateContent = createCanonicalCloseCandidateContent(validatedCandidate);
    await this.assertCurrentTaskOwnership(lease);
    await writeAtomically(paths.closeCandidate, serialize({
      candidate: validatedCandidate,
      hash: createHashForContent(candidateContent),
    }));
  }

  public async loadCloseCandidate(taskId: string): Promise<CloseCandidate | null> {
    assertTaskId(taskId);
    const paths = createSnapshotPaths(this.rootPath, taskId);
    let content: string;
    try {
      content = await readFile(paths.closeCandidate, "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) return null;
      throw new InvalidTaskStateError(`Unable to read durable close candidate for task ${taskId} at ${paths.closeCandidate}: ${describeError(error)}`);
    }
    const parsedRecord = persistedCloseCandidateSchema.safeParse(parseJson(content, taskId, paths.closeCandidate));
    if (!parsedRecord.success) {
      const issue = parsedRecord.error.issues[0];
      const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
      throw new InvalidTaskStateError(`Invalid persisted close candidate for task ${taskId} at ${paths.closeCandidate}: ${reason}`);
    }
    const candidate = parseCloseCandidate(parsedRecord.data.candidate, taskId, paths.closeCandidate);
    assertNoCredentialLikeFields(candidate, paths.closeCandidate, "closeCandidate");
    const observedHash = createHashForContent(createCanonicalCloseCandidateContent(candidate));
    if (observedHash !== parsedRecord.data.hash) {
      throwIntegrityError(taskId, paths.closeCandidate, parsedRecord.data.hash, observedHash, "close candidate content hash mismatch");
    }
    if (candidate.taskId !== taskId || candidate.durableContext.taskId !== taskId) {
      throw new InvalidTaskStateError(`Persisted close candidate task mismatch for task ${taskId}`);
    }
    return candidate;
  }

  public async loadGenerationManifest(taskId: string, manifestId: string): Promise<DurableContextManifest> {
    assertTaskId(taskId);
    assertSafeManifestId(manifestId, "Requested generation manifest id");
    const paths = createSnapshotPaths(this.rootPath, taskId);
    const manifestPath = generationPath(paths, manifestId, paths.manifest);
    const content = await readRequiredContent(taskId, manifestPath, "generation manifest");
    const manifest = parseManifest(parseJson(content, taskId, manifestPath), taskId, manifestPath);
    if (manifest.manifestId !== manifestId) throw new InvalidTaskStateError(`Generation manifest id mismatch for task ${taskId}`);
    assertManifestContract(manifest, taskId, paths);
    const manifestHash = manifest.hashes[paths.manifest];
    if (manifestHash === undefined) throw new InvalidTaskStateError(`Generation manifest for task ${taskId} is missing its manifest hash`);
    const observedManifestHash = createHashForContent(createCanonicalManifestContent(manifest));
    if (observedManifestHash !== manifestHash) throwIntegrityError(taskId, manifestPath, manifestHash, observedManifestHash, "canonical generation manifest hash mismatch");
    for (const activePath of allDurablePaths(paths)) {
      const expectedHash = manifest.hashes[activePath];
      if (expectedHash === undefined) throw new InvalidTaskStateError(`Generation manifest for task ${taskId} is missing a hash for ${activePath}`);
      const targetPath = generationPath(paths, manifestId, activePath);
      const artifact = await readRequiredContent(taskId, targetPath, expectedHash);
      if (activePath === paths.state) {
        const state = parseTaskState(parseJson(artifact, taskId, targetPath), targetPath);
        assertNoCredentialLikeFields(state, targetPath, "state");
        const observedStateHash = createHashForContent(createCanonicalStateContent(state));
        if (observedStateHash !== expectedHash) throwIntegrityError(taskId, targetPath, expectedHash, observedStateHash, "canonical generation state hash mismatch");
      } else if (activePath === paths.manifest) {
        continue;
      } else {
        assertRawHash(taskId, targetPath, artifact, expectedHash);
      }
    }
    return manifest;
  }

  public async recordCriticalUnsavedContext(taskId: string, items: readonly string[], lease?: TaskOwnershipLease): Promise<void> {
    if (lease === undefined) throw new TaskOwnershipError(`Critical unsaved context write requires ownership for task ${taskId}`);
    if (lease.taskId !== taskId) throw new TaskOwnershipError(`Critical unsaved context ownership task mismatch for task ${taskId}`);
    await this.assertCurrentTaskOwnership(lease);
    const state = await this.requireState(taskId);
    if (state.environment !== lease.environment) throw new TaskOwnershipError(`Critical unsaved context ownership environment mismatch for task ${taskId}`);
    await this.save({ ...state, criticalUnsavedContext: [...items] }, lease);
  }

  public async clearCriticalUnsavedContext(taskId: string, lease?: TaskOwnershipLease): Promise<void> {
    if (lease === undefined) throw new TaskOwnershipError(`Critical unsaved context clear requires ownership for task ${taskId}`);
    if (lease.taskId !== taskId) throw new TaskOwnershipError(`Critical unsaved context ownership task mismatch for task ${taskId}`);
    await this.assertCurrentTaskOwnership(lease);
    const state = await this.requireState(taskId);
    if (state.environment !== lease.environment) throw new TaskOwnershipError(`Critical unsaved context ownership environment mismatch for task ${taskId}`);
    await this.save({ ...state, criticalUnsavedContext: [] }, lease);
  }

  public async withTaskOwnership<T>(
    taskId: string,
    environment: Environment,
    operation: (
      lease: TaskOwnershipLease,
      transfer: TaskOwnershipTransfer,
      assertOwnership: TaskOwnershipGuard,
      authorizeTransition: TaskOwnershipTransitionAuthorizer,
    ) => Promise<T>,
  ): Promise<T> {
    assertTaskId(taskId);
    let currentLease = await this.acquireTaskOwnership(taskId, environment);
    let heartbeatFailure: TaskOwnershipError | null = null;
    const lease: TaskOwnershipLease = {
      taskId: currentLease.taskId,
      environment: currentLease.environment,
      generation: currentLease.generation,
      ownerToken: currentLease.ownerToken,
    };
    const assertOwnership = async (): Promise<void> => {
      if (heartbeatFailure !== null) throw heartbeatFailure;
      await this.assertCurrentTaskOwnership(currentLease);
      if (heartbeatFailure !== null) throw heartbeatFailure;
    };
    const transfer: TaskOwnershipTransfer = async (targetEnvironment: Environment): Promise<TaskOwnershipLease> => {
      await assertOwnership();
      currentLease = await this.transferTaskOwnership(currentLease, targetEnvironment);
      await assertOwnership();
      return {
        taskId: currentLease.taskId,
        environment: currentLease.environment,
        generation: currentLease.generation,
        ownerToken: currentLease.ownerToken,
      };
    };
    const authorizeTransition: TaskOwnershipTransitionAuthorizer = (targetEnvironment) => {
      if (targetEnvironment === lease.environment) return lease;
      const transition = { lease, targetEnvironment } as TaskOwnershipTransition;
      this.issuedTransitions.add(transition);
      return transition;
    };
    const heartbeat = setInterval(() => {
      if (heartbeatFailure !== null) return;
      void this.renewTaskOwnership(currentLease).catch((error: unknown) => {
        heartbeatFailure = error instanceof TaskOwnershipError
          ? error
          : new TaskOwnershipError(`Unable to renew durable ownership for task ${taskId}: ${describeError(error)}`);
      });
    }, Math.max(1, Math.floor(FILE_DURABLE_CONTEXT_LEASE_MS / 3)));
    try {
      const result = await operation(lease, transfer, assertOwnership, authorizeTransition);
      await assertOwnership();
      return result;
    } finally {
      clearInterval(heartbeat);
      await this.releaseTaskOwnership(currentLease);
    }
  }

  private async renewTaskOwnership(lease: FileTaskOwnershipLease): Promise<void> {
    await this.assertCurrentTaskOwnership(lease);
    await utimes(join(lease.generationPath, ownershipLeaseFile), new Date(), new Date());
  }

  private async acquireTaskOwnership(taskId: string, environment: Environment): Promise<FileTaskOwnershipLease> {
    const ownershipRoot = join(createSnapshotPaths(this.rootPath, taskId).taskRoot, ownershipDirectoryName);
    try {
      await mkdir(ownershipRoot, { recursive: true });
      while (true) {
        const latest = await this.latestOwnershipGeneration(ownershipRoot);
        if (latest !== null && !await this.isOwnershipReleased(latest) && !await this.isOwnershipExpired(latest)) {
          const owner = await this.readOwnershipRecord(latest.generationPath);
          throw new TaskOwnershipError(`Task ${taskId} is actively owned by ${owner.environment}`);
        }
        const generation = (latest?.generation ?? 0n) + 1n;
        const generationPath = join(ownershipRoot, generation.toString());
        const ownerToken = randomUUID();
        try {
          await mkdir(generationPath);
          await writeFile(
            join(generationPath, ownershipOwnerFile),
            serialize({ taskId, environment, ownerToken }),
            { encoding: "utf8", flag: "wx" },
          );
          await writeFile(join(generationPath, ownershipLeaseFile), ownerToken, { encoding: "utf8", flag: "wx" });
          return { taskId, environment, generation, ownerToken, generationPath, ownershipRoot };
        } catch (error: unknown) {
          if (isAlreadyExistsError(error)) continue;
          throw error;
        }
      }
    } catch (error: unknown) {
      if (error instanceof TaskOwnershipError) throw error;
      throw new TaskOwnershipError(`Unable to acquire durable ownership for task ${taskId}: ${describeError(error)}`);
    }
  }

  private async transferTaskOwnership(lease: FileTaskOwnershipLease, targetEnvironment: Environment): Promise<FileTaskOwnershipLease> {
    try {
      await this.assertCurrentTaskOwnership(lease);
      const temporaryPath = join(lease.generationPath, `.${ownershipTransferFile}.${randomUUID()}.tmp`);
      await writeFile(
        temporaryPath,
        serialize({
          taskId: lease.taskId,
          ownerToken: lease.ownerToken,
          sourceEnvironment: lease.environment,
          targetEnvironment,
        }),
        { encoding: "utf8", flag: "wx" },
      );
      await this.assertCurrentTaskOwnership(lease);
      await rename(temporaryPath, join(lease.generationPath, ownershipTransferFile));
      return { ...lease, environment: targetEnvironment };
    } catch (error: unknown) {
      if (error instanceof TaskOwnershipError) throw error;
      throw new TaskOwnershipError(`Unable to transfer durable ownership for task ${lease.taskId}: ${describeError(error)}`);
    }
  }

  private async releaseTaskOwnership(lease: FileTaskOwnershipLease): Promise<void> {
    try {
      const latest = await this.latestOwnershipGeneration(lease.ownershipRoot);
      if (latest === null || latest.generation !== lease.generation) return;
      if (await this.isOwnershipReleased(latest)) return;
      await this.assertTaskOwnershipToken(lease);
      const temporaryPath = join(lease.generationPath, `.${ownershipReleasedFile}.${randomUUID()}.tmp`);
      await writeFile(temporaryPath, lease.ownerToken, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, join(lease.generationPath, ownershipReleasedFile));
    } catch (error: unknown) {
      if (isAlreadyExistsError(error)) return;
      if (error instanceof TaskOwnershipError) throw error;
      throw new TaskOwnershipError(`Unable to release durable ownership for task ${lease.taskId}: ${describeError(error)}`);
    }
  }

  private async latestOwnershipGeneration(ownershipRoot: string): Promise<FileTaskOwnershipGeneration | null> {
    let entries: Dirent<string>[];
    try {
      entries = await readdir(ownershipRoot, { withFileTypes: true });
    } catch (error: unknown) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    const generations: FileTaskOwnershipGeneration[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) {
        throw new TaskOwnershipError(`Invalid durable ownership generation at ${ownershipRoot}: ${entry.name}`);
      }
      generations.push({ generation: BigInt(entry.name), generationPath: join(ownershipRoot, entry.name) });
    }
    return generations.sort((left, right) => left.generation === right.generation ? 0 : left.generation > right.generation ? -1 : 1)[0] ?? null;
  }

  private async isOwnershipReleased(generation: FileTaskOwnershipGeneration): Promise<boolean> {
    let releasedToken: string;
    try {
      releasedToken = await readFile(join(generation.generationPath, ownershipReleasedFile), "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
    const [owner, leaseToken] = await Promise.all([
      this.readOwnershipRecord(generation.generationPath),
      readFile(join(generation.generationPath, ownershipLeaseFile), "utf8"),
    ]);
    if (releasedToken !== owner.ownerToken || releasedToken !== leaseToken) {
      throw new TaskOwnershipError(`Invalid released durable ownership marker at ${generation.generationPath}`);
    }
    return true;
  }

  private async isOwnershipExpired(generation: FileTaskOwnershipGeneration): Promise<boolean> {
    try {
      const leaseStats = await stat(join(generation.generationPath, ownershipLeaseFile));
      if (!leaseStats.isFile()) throw new TaskOwnershipError(`Invalid durable ownership lease at ${generation.generationPath}`);
      return Date.now() - leaseStats.mtimeMs > FILE_DURABLE_CONTEXT_LEASE_MS;
    } catch (error: unknown) {
      if (error instanceof TaskOwnershipError) throw error;
      if (!isMissingFileError(error)) throw error;
    }
    const generationStats = await stat(generation.generationPath);
    if (!generationStats.isDirectory()) throw new TaskOwnershipError(`Invalid durable ownership generation at ${generation.generationPath}`);
    return Date.now() - generationStats.mtimeMs > FILE_DURABLE_CONTEXT_LEASE_MS;
  }

  private async assertCurrentTaskOwnership(lease: TaskOwnershipLease): Promise<void> {
    const ownershipRoot = join(createSnapshotPaths(this.rootPath, lease.taskId).taskRoot, ownershipDirectoryName);
    const latest = await this.latestOwnershipGeneration(ownershipRoot);
    if (latest === null || latest.generation !== lease.generation) {
      throw new TaskOwnershipError(`Durable ownership for task ${lease.taskId} was superseded`);
    }
    if (await this.isOwnershipReleased(latest) || await this.isOwnershipExpired(latest)) {
      throw new TaskOwnershipError(`Durable ownership for task ${lease.taskId} is no longer active`);
    }
    await this.assertTaskOwnershipToken(lease);
  }

  private async assertTaskOwnershipToken(lease: TaskOwnershipLease): Promise<void> {
    const generationPath = join(createSnapshotPaths(this.rootPath, lease.taskId).taskRoot, ownershipDirectoryName, lease.generation.toString());
    const [owner, leaseToken] = await Promise.all([
      this.readOwnershipRecord(generationPath),
      readFile(join(generationPath, ownershipLeaseFile), "utf8"),
    ]);
    if (owner.taskId !== lease.taskId || owner.ownerToken !== lease.ownerToken || leaseToken !== lease.ownerToken) {
      throw new TaskOwnershipError(`Durable ownership token mismatch for task ${lease.taskId}`);
    }
    let authoritativeEnvironment = owner.environment;
    try {
      const transferPath = join(generationPath, ownershipTransferFile);
      const transfer = ownershipTransferSchema.safeParse(parseJson(await readFile(transferPath, "utf8"), lease.taskId, transferPath));
      if (!transfer.success) throw new TaskOwnershipError(`Invalid durable ownership transfer at ${transferPath}`);
      if (
        transfer.data.taskId !== lease.taskId
        || transfer.data.ownerToken !== lease.ownerToken
        || transfer.data.sourceEnvironment !== owner.environment
      ) throw new TaskOwnershipError(`Durable ownership transfer mismatch for task ${lease.taskId}`);
      authoritativeEnvironment = transfer.data.targetEnvironment;
    } catch (error: unknown) {
      if (!isMissingFileError(error)) throw error;
    }
    if (authoritativeEnvironment !== lease.environment) {
      throw new TaskOwnershipError(`Durable ownership environment mismatch for task ${lease.taskId}`);
    }
  }

  private async readOwnershipRecord(generationPath: string): Promise<z.infer<typeof ownershipRecordSchema>> {
    const targetPath = join(generationPath, ownershipOwnerFile);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(targetPath, "utf8"));
    } catch (error: unknown) {
      throw new TaskOwnershipError(`Unable to read durable ownership record at ${targetPath}: ${describeError(error)}`);
    }
    const result = ownershipRecordSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
      throw new TaskOwnershipError(`Invalid durable ownership record at ${targetPath}: ${reason}`);
    }
    return result.data;
  }

  private async requireState(taskId: string): Promise<TaskState> {
    const state = await this.load(taskId);
    if (state === null) {
      throw new InvalidTaskStateError(`No durable task state exists for task id ${taskId}`);
    }
    return state;
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
