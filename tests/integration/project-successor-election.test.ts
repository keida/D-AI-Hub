import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TaskOwnershipError } from "../../src/domain/errors.js";
import type { TaskCharter, TaskState } from "../../src/domain/types.js";
import { taskCharterContentDigest, taskCharterTaskId } from "../../src/state/task-charter.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

interface ChildEvent {
  readonly type: "ready" | "result";
  readonly [key: string]: unknown;
}

interface ChildHandle {
  readonly child: ChildProcess;
  readonly events: ChildEvent[];
}

const childScript = fileURLToPath(new URL("./project-successor-election-child.ts", import.meta.url));

function makeState(projectIdentity: string, objective = "Establish the approved successor"): { state: TaskState; digest: string } {
  const content = {
    schemaVersion: 1 as const,
    charterId: "successor-election-test",
    charterVersion: "1",
    projectIdentity,
    objective,
    ownedScope: ["successor-specific implementation"],
    excludedScope: ["unrelated projects"],
    completionCriteria: ["focused verification passes"],
    terminationCondition: "Stop when the approved scope is complete.",
    initialNextAction: "Inspect the canonical project state.",
  };
  const digest = taskCharterContentDigest(content);
  const taskCharter: TaskCharter = {
    ...content,
    approval: {
      confirmation: "I_APPROVE_THIS_TASK_CHARTER" as const,
      approvedBy: "integration-test-operator",
      approvedAt: "2026-09-26T00:00:00.000Z",
      approvalReference: "temporary test fixture",
      projectIdentity,
      approvedCharterDigest: digest,
    },
  };
  const taskId = taskCharterTaskId(projectIdentity, digest);
  return {
    digest,
    state: {
      taskId,
      goal: content.objective,
      constraints: [],
      environment: "codex",
      stage: "bootstrap",
      routingDisposition: "ROUTABLE",
      taskCharter,
      taskCharterConfirmation: {
        confirmationId: "00000000-0000-4000-8000-000000000011",
        confirmedAt: "2026-09-26T00:00:00.000Z",
        projectIdentity,
        confirmedCharterDigest: digest,
        channel: "explicit-task-charter-digest",
      },
      role: "analyst",
      routingDecision: null,
      selectedCapabilities: [],
      contextManifest: [`identity:workspace:C:/tmp/successor-election-test:${"a".repeat(64)}`],
      handoffState: "none",
      verificationEvidence: [],
      recoveryPoint: null,
      approvalState: "approved",
      criticalUnsavedContext: [],
      durableContext: null,
    },
  };
}

function launchChild(root: string, projectIdentity: string, digest: string, state: TaskState, action: "publish" | "register" = "publish"): ChildHandle {
  const child = fork(childScript, [], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const events: ChildEvent[] = [];
  child.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && "type" in message) events.push(message as ChildEvent);
  });
  child.send({ type: "begin", request: { root, projectIdentity, charterDigest: digest, state, action } });
  return { child, events };
}

async function waitForEvent(handle: ChildHandle, type: ChildEvent["type"]): Promise<ChildEvent> {
  const found = handle.events.find((event) => event.type === type);
  if (found !== undefined) return found;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child ${type} event`)), 20_000);
    const onMessage = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("type" in message) || message.type !== type) return;
      clearTimeout(timeout);
      handle.child.off("message", onMessage);
      resolve(message as ChildEvent);
    };
    handle.child.on("message", onMessage);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      handle.child.off("message", onMessage);
      reject(new Error(`Child exited before ${type}: ${code ?? signal ?? "unknown"}`));
    };
    handle.child.once("exit", onExit);
    handle.child.once("error", (error) => {
      clearTimeout(timeout);
      handle.child.off("message", onMessage);
      reject(error);
    });
  });
}

async function finishChild(handle: ChildHandle): Promise<void> {
  if (handle.child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    handle.child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Child exited with ${code ?? "signal"}`)));
  });
}

async function stopChildren(handles: readonly ChildHandle[]): Promise<void> {
  for (const { child } of handles) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(handles.map(async ({ child }) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }));
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-successor-election-"));
  try { return await run(root); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
}

async function taskDirectories(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^task-/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function snapshotFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else result[relative] = await readFile(join(directory, entry.name), "utf8");
    }
  }
  await visit(root, "");
  return result;
}

describe("project successor file-store election", () => {
  it("fences two independent processes with competing charters before either publishes", async () => withRoot(async (root) => {
    const projectIdentity = "project:successor-election-conflict-before-publication";
    const first = makeState(projectIdentity, "First approved contender");
    const second = makeState(projectIdentity, "Second approved contender");
    const handles = [
      launchChild(root, projectIdentity, first.digest, first.state),
      launchChild(root, projectIdentity, second.digest, second.state),
    ];
    try {
      const ready = await Promise.all(handles.map((handle) => waitForEvent(handle, "ready")));
      expect(ready.every((event) => event.registration === "registered" || event.registration === "conflict")).toBe(true);
      expect(ready.some((event) => event.registration === "conflict")).toBe(true);
      for (const handle of handles) handle.child.send({ type: "publish" });
      const results = await Promise.all(handles.map((handle) => waitForEvent(handle, "result")));
      expect(results.every((event) => event.outcome === "error" && event.errorName === TaskOwnershipError.name)).toBe(true);
      const store = new FileDurableContextStore(root);
      await expect(store.hasProjectSuccessorConflict(projectIdentity)).resolves.toBe(true);
      await expect(taskDirectories(root)).resolves.toEqual([]);
      await Promise.all(handles.map(finishChild));
    } finally {
      await stopChildren(handles);
    }
  }), 30_000);

  it("converges twelve independent publishers on one deterministic task with a strict-loadable snapshot", async () => withRoot(async (root) => {
    const projectIdentity = "project:successor-election-identical-charter";
    const { state, digest } = makeState(projectIdentity);
    const handles = Array.from({ length: 12 }, () => launchChild(root, projectIdentity, digest, state));
    try {
      const ready = await Promise.all(handles.map((handle) => waitForEvent(handle, "ready")));
      expect(ready.every((event) => event.registration === "registered")).toBe(true);
      for (const handle of handles) handle.child.send({ type: "publish" });
      const results = await Promise.all(handles.map((handle) => waitForEvent(handle, "result")));
      expect(results.every((event) => event.outcome === "published")).toBe(true);
      expect(new Set(results.map((event) => event.taskId))).toEqual(new Set([state.taskId]));
      const store = new FileDurableContextStore(root);
      expect(await store.hasProjectSuccessorConflict(projectIdentity)).toBe(false);
      expect(await taskDirectories(root)).toEqual([state.taskId]);
      const loaded = await store.load(state.taskId);
      expect(loaded).toMatchObject({ taskId: state.taskId, routingDisposition: "ROUTABLE", taskCharter: { projectIdentity } });
      await store.verifyDurableSnapshot(loaded!.durableContext!);
      const generations = await readdir(join(root, state.taskId, "generations"), { withFileTypes: true });
      expect(generations.filter((entry) => entry.isDirectory()).length).toBeGreaterThan(0);
      for (const generation of generations.filter((entry) => entry.isDirectory())) {
        const manifest = await store.loadGenerationManifest(state.taskId, generation.name);
        expect(manifest.durablePaths.every((path) => path.startsWith(join(root, state.taskId)))).toBe(true);
      }
      await Promise.all(handles.map(finishChild));
    } finally {
      await stopChildren(handles);
    }
  }), 45_000);

  it("keeps a published task byte-for-byte intact while a later different charter permanently conflicts", async () => withRoot(async (root) => {
    const projectIdentity = "project:successor-election-conflict-after-publication";
    const first = makeState(projectIdentity, "Published charter");
    const second = makeState(projectIdentity, "Later competing charter");
    const store = new FileDurableContextStore(root);
    await store.createSuccessorIfAbsent(first.state, projectIdentity, first.digest);
    const before = await snapshotFiles(join(root, first.state.taskId));
    const contender = launchChild(root, projectIdentity, second.digest, second.state);
    try {
      const ready = await waitForEvent(contender, "ready");
      expect(ready.registration).toBe("conflict");
      contender.child.send({ type: "publish" });
      const result = await waitForEvent(contender, "result");
      expect(result).toMatchObject({ type: "result", outcome: "error", errorName: TaskOwnershipError.name });
      await expect(store.hasProjectSuccessorConflict(projectIdentity)).resolves.toBe(true);
      await expect(taskDirectories(root)).resolves.toEqual([first.state.taskId]);
      expect(await snapshotFiles(join(root, first.state.taskId))).toEqual(before);
      await Promise.all([finishChild(contender), store.load(first.state.taskId).then((loaded) => expect(loaded?.taskId).toBe(first.state.taskId))]);
    } finally {
      await stopChildren([contender]);
    }
  }), 30_000);

  it("removes a partially written private stage after injected failure and permits a strict-load-verified retry", async () => withRoot(async (root) => {
    const projectIdentity = "project:successor-election-fault-retry";
    const { state, digest } = makeState(projectIdentity);
    const failingStore = new FileDurableContextStore(root, {
      afterInitialCompanionsWritten: async () => { throw new Error("injected post-companion failure"); },
    });
    await expect(failingStore.createSuccessorIfAbsent(state, projectIdentity, digest)).rejects.toThrow("injected post-companion failure");
    await expect(taskDirectories(root)).resolves.toEqual([]);
    await expect(readdir(root).then((entries) => entries.filter((entry) => entry.startsWith(".successor-staging-")))).resolves.toEqual([]);
    expect(await new FileDurableContextStore(root).hasProjectSuccessorConflict(projectIdentity)).toBe(false);

    const retryStore = new FileDurableContextStore(root);
    await retryStore.createSuccessorIfAbsent(state, projectIdentity, digest);
    const loaded = await retryStore.load(state.taskId);
    expect(loaded).toMatchObject({ taskId: state.taskId, routingDisposition: "ROUTABLE" });
    await retryStore.verifyDurableSnapshot(loaded!.durableContext!);
    await expect(taskDirectories(root)).resolves.toEqual([state.taskId]);
  }), 30_000);
});
