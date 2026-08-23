import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { InvalidTaskStateError } from "../domain/errors.js";
import type { Environment, TaskState } from "../domain/types.js";
import type { DurableContextStore } from "../state/durable-context-store.js";

export interface BootstrapInput {
  readonly taskId: string | null;
  readonly goal: string;
  readonly environment: Environment;
  readonly workspacePath: string | null;
  readonly repositoryPath: string | null;
}

interface InspectedIdentity {
  readonly kind: "workspace" | "repository";
  readonly path: string;
  readonly hash: string;
}

const excludedDirectoryNames: ReadonlySet<string> = new Set([".d-ai", ".git", "node_modules"]);

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function hashPath(path: string, rootPath: string): Promise<string> {
  const entry = await lstat(path);
  const relativePath = relative(rootPath, path).replaceAll("\\", "/") || ".";
  if (entry.isSymbolicLink()) {
    const target = await realpath(path);
    return sha256(`link:${relativePath}:${target}`);
  }
  if (entry.isFile()) {
    return createHash("sha256")
      .update(`file:${relativePath}:`, "utf8")
      .update(await readFile(path))
      .digest("hex");
  }
  if (!entry.isDirectory()) {
    return sha256(`other:${relativePath}`);
  }

  const children = await readdir(path, { withFileTypes: true });
  const hashes: string[] = [];
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    if (child.isDirectory() && excludedDirectoryNames.has(child.name)) {
      continue;
    }
    hashes.push(await hashPath(join(path, child.name), rootPath));
  }
  return sha256(`directory:${relativePath}:${hashes.join(":")}`);
}

async function inspectIdentity(kind: "workspace" | "repository", suppliedPath: string): Promise<InspectedIdentity> {
  const path = resolve(suppliedPath);
  try {
    const canonicalPath = await realpath(path);
    return { kind, path: canonicalPath, hash: await hashPath(canonicalPath, canonicalPath) };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidTaskStateError(`Unable to inspect ${kind} identity at ${path}: ${reason}`);
  }
}

function serializeIdentity(identity: InspectedIdentity): string {
  return `identity:${identity.kind}:${identity.path}:${identity.hash}`;
}

function createTaskId(goal: string, environment: Environment, identities: readonly string[]): string {
  return `task-${sha256(`${goal}\n${environment}\n${identities.join("\n")}`).slice(0, 24)}`;
}

function assertBootstrapInput(input: BootstrapInput): void {
  if (input.goal.trim().length === 0) {
    throw new InvalidTaskStateError("Bootstrap goal must not be empty");
  }
  if (input.workspacePath === null && input.repositoryPath === null) {
    throw new InvalidTaskStateError("Bootstrap identity is ambiguous: provide workspacePath or repositoryPath");
  }
}

function assertRecoveredIdentity(state: TaskState, identities: readonly string[]): void {
  const storedIdentities = state.contextManifest.filter((entry) => entry.startsWith("identity:"));
  if (storedIdentities.length !== identities.length || storedIdentities.some((entry) => !identities.includes(entry))) {
    throw new InvalidTaskStateError(`Bootstrap identity mismatch for task ${state.taskId}`);
  }
}

export async function prepareBootstrapTask(input: BootstrapInput, store: DurableContextStore): Promise<TaskState> {
  assertBootstrapInput(input);
  const identities = [
    ...(input.workspacePath === null ? [] : [await inspectIdentity("workspace", input.workspacePath)]),
    ...(input.repositoryPath === null ? [] : [await inspectIdentity("repository", input.repositoryPath)]),
  ].map(serializeIdentity);
  const taskId = input.taskId ?? createTaskId(input.goal, input.environment, identities);
  const existingState = await store.load(taskId);
  if (existingState !== null) {
    if (existingState.goal !== input.goal || existingState.environment !== input.environment) {
      throw new InvalidTaskStateError(`Bootstrap input does not match recovered task ${taskId}`);
    }
    assertRecoveredIdentity(existingState, identities);
    return existingState;
  }

  const state: TaskState = {
    taskId,
    goal: input.goal,
    constraints: [],
    environment: input.environment,
    stage: "bootstrap",
    role: "analyst",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: identities,
    handoffState: "none",
    verificationEvidence: [],
    recoveryPoint: null,
    approvalState: "not-required",
    criticalUnsavedContext: [],
    durableContext: null,
  };
  return state;
}

export async function bootstrapTask(input: BootstrapInput, store: DurableContextStore): Promise<TaskState> {
  const state = await prepareBootstrapTask(input, store);
  if (state.durableContext !== null) return state;
  if (store.createIfAbsent === undefined) {
    throw new InvalidTaskStateError("Bootstrap persistence requires an atomic create-if-absent durable store operation");
  }
  const manifest = await store.createIfAbsent(state);
  return { ...state, durableContext: manifest };
}
