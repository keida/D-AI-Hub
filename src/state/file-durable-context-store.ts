import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
    let content: string;
    try {
      content = await readFile(paths.state, "utf8");
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        return null;
      }
      throw new InvalidTaskStateError(`Unable to read durable task state at ${paths.state}: ${describeError(error)}`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: unknown) {
      throw new InvalidTaskStateError(`Invalid task state at ${paths.state}: ${describeError(error)}`);
    }
    assertNoCredentialLikeFields(parsed, paths.state, "state");
    return parseTaskState(parsed, paths.state);
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
    const hashes: Record<string, string> = {};
    for (const [path, content] of contents) {
      hashes[path] = createHashForContent(content);
    }
    const manifest: DurableContextManifest = {
      manifestId: randomUUID(),
      taskId: validatedState.taskId,
      stage: validatedState.stage,
      environment: validatedState.environment,
      role: validatedState.role,
      durablePaths: [...contents.keys(), paths.state, paths.manifest],
      hashes,
      recoveryPointId: validatedState.recoveryPoint?.recoveryPointId ?? null,
      recordedAt: new Date().toISOString(),
    };
    const persistedState: TaskState = { ...validatedState, durableContext: manifest };
    const stateContent = serialize(persistedState);
    const manifestContent = serialize(manifest);

    for (const [path, content] of contents) {
      await writeAtomically(path, content);
    }
    await writeAtomically(paths.manifest, manifestContent);
    await writeAtomically(paths.state, stateContent);
    return manifest;
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
