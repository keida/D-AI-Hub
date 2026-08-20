import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import { InvalidTaskStateError } from "../domain/errors.js";
import type { DurableContextManifest, TaskState } from "../domain/types.js";
import type { DurableContextStore } from "./durable-context-store.js";

const taskIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const credentialFieldPattern = /(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?|credential|cookie|password|private[_-]?key|secret|session[_-]?token)/i;

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
    manifestId: z.string().min(1),
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
    snapshotManifestId: z.string().min(1).optional(),
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
    recoveryPoint: recoveryPointSchema.nullable(),
    approvalState: z.enum(["not-required", "pending", "approved", "rejected"]),
    criticalUnsavedContext: z.array(z.string()),
    durableContext: manifestSchema.nullable(),
  })
  .strict();
const contextRecordSchema = z
  .object({
    goal: z.string().min(1),
    constraints: z.array(z.string()),
    contextManifest: z.array(z.string()),
  })
  .strict();
const evidenceRecordSchema = z.object({ verificationEvidence: z.array(verificationEvidenceSchema) }).strict();
const approvalRecordSchema = z
  .object({ approvalState: z.enum(["not-required", "pending", "approved", "rejected"]), criticalUnsavedContext: z.array(z.string()) })
  .strict();
const handoffRecordSchema = z
  .object({ handoffState: z.enum(["none", "pending", "acknowledged", "active", "completed", "rejected"]) })
  .strict();
const recoveryRecordSchema = z.object({ recoveryPoint: recoveryPointSchema.nullable() }).strict();

interface SnapshotPaths {
  readonly taskRoot: string;
  readonly state: string;
  readonly context: string;
  readonly evidence: string;
  readonly approval: string;
  readonly handoff: string;
  readonly recovery: string;
  readonly manifest: string;
}

function createHashForContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
  };
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

export class FileDurableContextStore implements DurableContextStore {
  private readonly rootPath: string;

  public constructor(rootPath: string) {
    this.rootPath = resolve(rootPath);
  }

  public async load(taskId: string): Promise<TaskState | null> {
    assertTaskId(taskId);
    const paths = createSnapshotPaths(this.rootPath, taskId);
    let stateContent: string;
    try {
      stateContent = await readFile(paths.state, "utf8");
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

    const manifestContent = await readRequiredContent(taskId, paths.manifest, "declared SHA-256");
    const manifest = parseManifest(parseJson(manifestContent, taskId, paths.manifest), taskId, paths.manifest);
    assertManifestContract(manifest, taskId, paths);
    const manifestHash = manifest.hashes[paths.manifest];
    const stateHash = manifest.hashes[paths.state];
    if (manifestHash === undefined || stateHash === undefined) {
      throw new InvalidTaskStateError(`Manifest contract for task ${taskId} is missing required state integrity hashes`);
    }

    const state = parseTaskState(parseJson(stateContent, taskId, paths.state), paths.state);
    assertNoCredentialLikeFields(state, paths.state, "state");
    const observedStateHash = createHashForContent(createCanonicalStateContent(state));
    if (observedStateHash !== stateHash) {
      throwIntegrityError(taskId, paths.state, stateHash, observedStateHash, "canonical state hash mismatch");
    }
    const observedManifestHash = createHashForContent(createCanonicalManifestContent(manifest));
    if (observedManifestHash !== manifestHash) {
      throwIntegrityError(taskId, paths.manifest, manifestHash, observedManifestHash, "canonical manifest hash mismatch");
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
    }

    if (state.durableContext === null || JSON.stringify(state.durableContext) !== JSON.stringify(manifest)) {
      throwIntegrityError(taskId, paths.state, manifestHash, "state manifest mismatch", "state does not contain the persisted manifest");
    }
    return state;
  }

  public async save(state: TaskState): Promise<DurableContextManifest> {
    assertTaskId(state.taskId);
    const paths = createSnapshotPaths(this.rootPath, state.taskId);
    assertNoCredentialLikeFields(state, paths.state, "state");
    const validatedState = parseTaskState(state, paths.state);
    await mkdir(paths.taskRoot, { recursive: true });

    const contents = new Map<string, string>([
      [paths.context, serialize({ goal: validatedState.goal, constraints: validatedState.constraints, contextManifest: validatedState.contextManifest })],
      [paths.evidence, serialize({ verificationEvidence: validatedState.verificationEvidence })],
      [paths.approval, serialize({ approvalState: validatedState.approvalState, criticalUnsavedContext: validatedState.criticalUnsavedContext })],
      [paths.handoff, serialize({ handoffState: validatedState.handoffState })],
      [paths.recovery, serialize({ recoveryPoint: validatedState.recoveryPoint })],
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

    for (const [path, content] of contents) {
      await writeAtomically(path, content);
    }
    await writeAtomically(paths.manifest, manifestContent);
    await writeAtomically(paths.state, stateContent);
    return persistedManifest;
  }

  public async recordCriticalUnsavedContext(taskId: string, items: readonly string[]): Promise<void> {
    const state = await this.requireState(taskId);
    await this.save({ ...state, criticalUnsavedContext: [...items] });
  }

  public async clearCriticalUnsavedContext(taskId: string): Promise<void> {
    const state = await this.requireState(taskId);
    await this.save({ ...state, criticalUnsavedContext: [] });
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
