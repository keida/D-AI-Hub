import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { createConfiguredDAIRuntime } from "../../src/runtime/d-ai-runtime.js";
import { prepareBootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { buildCurationBoundarySha256, createCurationPipeline } from "../../src/curation/current-view-pipeline.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";
import { resolveLocalMemoryScopeId } from "../../src/memory/local-memory-path.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

const localProjectPattern = /^local-project:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function snapshotFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1);
      if (entry.isDirectory()) await visit(path);
      else snapshot[relative] = await readFile(path, "utf8");
    }
  }
  await visit(root);
  return snapshot;
}

async function git(cwd: string | null, arguments_: readonly string[]): Promise<string> {
  return (await runCommand({ command: "git", arguments: arguments_, cwd })).stdout.trim();
}

async function establish(workspacePath: string, durableRoot: string, goal: string) {
  return createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({
    rawCommand: `@D-AI establish ${goal}`,
    taskId: null,
  });
}

async function seedLocalTask(store: FileDurableContextStore, workspacePath: string, taskId: string, localProjectId: string, environment: "chat" | "work" | "codex" = "codex"): Promise<void> {
  const state = await prepareBootstrapTask({
    taskId,
    goal: `Seed ${taskId}`,
    environment,
    workspacePath,
    repositoryPath: null,
    localProjectId,
  }, store);
  await store.createIfAbsent!(state);
}

async function seedProjectIdentityTask(
  store: FileDurableContextStore,
  workspacePath: string,
  taskId: string,
  localProjectId: string | null,
  additionalEntries: readonly string[] = [],
): Promise<void> {
  const state = await prepareBootstrapTask({
    taskId,
    goal: `Seed ${taskId}`,
    environment: "codex",
    workspacePath,
    repositoryPath: null,
    ...(localProjectId === null ? {} : { localProjectId }),
  }, store);
  await store.createIfAbsent!({ ...state, contextManifest: [...state.contextManifest, ...additionalEntries] });
}

async function seedRepositoryTask(store: FileDurableContextStore, workspacePath: string, taskId: string, repository: string): Promise<void> {
  const state = await prepareBootstrapTask({
    taskId,
    goal: `Seed ${taskId}`,
    environment: "codex",
    workspacePath,
    repositoryPath: workspacePath,
  }, store);
  await store.createIfAbsent!({ ...state, contextManifest: [...state.contextManifest, `remote-repository:${repository}`] });
}

describe("configured Codex local-only identity", () => {
  it("creates exactly one durable UUID identity and reuses it for repeated establish", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-establish-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const first = await activate({ rawCommand: "@D-AI establish local project", taskId: null });
      expect(first).toMatchObject({ status: "accepted", stage: "bootstrap" });
      const continued = await activate({ rawCommand: `@D-AI continue ${first.taskId}`, taskId: first.taskId });
      expect(continued).toMatchObject({ taskId: first.taskId, status: "accepted", stage: "bootstrap" });
      expect(continued.message).not.toMatch(/recover/i);
      const beforeRepeat = await snapshotFiles(durableRoot);
      const second = await activate({ rawCommand: "@D-AI establish different display name", taskId: null });
      const store = new FileDurableContextStore(durableRoot);
      const tasks = await store.discoverActiveTasks(workspacePath);
      expect(tasks).toHaveLength(1);
      expect(second.taskId).toBe(first.taskId);
      expect(second.status).toBe("accepted");
      expect(await snapshotFiles(durableRoot)).toEqual(beforeRepeat);
      const localEntries = tasks[0]!.contextManifest.filter((entry) => entry.startsWith("local-project:"));
      expect(localEntries).toHaveLength(1);
      expect(localProjectPattern.test(localEntries[0]!)).toBe(true);
      expect(tasks[0]!.contextManifest.filter((entry) => entry.startsWith("remote-repository:"))).toHaveLength(0);
      const status = await activate({ rawCommand: "@D-AI status", taskId: null });
      expect(status).toMatchObject({ taskId: first.taskId, status: "accepted" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent local-only establish into one durable identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-concurrent-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const [first, second] = await Promise.all([
        activate({ rawCommand: "@D-AI establish local project one", taskId: null }),
        activate({ rawCommand: "@D-AI establish local project two", taskId: null }),
      ]);
      expect(first).toMatchObject({ status: "accepted", stage: "bootstrap" });
      expect(second).toMatchObject({ status: "accepted", stage: "bootstrap" });
      expect(second.taskId).toBe(first.taskId);
      const store = new FileDurableContextStore(durableRoot);
      expect(await store.discoverActiveTasks(workspacePath)).toHaveLength(1);
      const durableEntries = await readdir(durableRoot, { withFileTypes: true });
      expect(durableEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith("task-")).map((entry) => entry.name)).toEqual([first.taskId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("converges across independent configured runtimes on one local-only identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-cross-runtime-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const firstActivate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const secondActivate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const [first, second] = await Promise.all([
        firstActivate({ rawCommand: "@D-AI establish cross-runtime one", taskId: null }),
        secondActivate({ rawCommand: "@D-AI establish cross-runtime two", taskId: null }),
      ]);
      expect(first).toMatchObject({ status: "accepted", stage: "bootstrap" });
      expect(second).toMatchObject({ status: "accepted", stage: "bootstrap" });
      expect(second.taskId).toBe(first.taskId);
      const store = new FileDurableContextStore(durableRoot);
      const tasks = await store.discoverActiveTasks(workspacePath);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.taskId).toBe(first.taskId);
      expect(tasks[0]?.contextManifest.filter((entry) => entry.startsWith("local-project:"))).toHaveLength(1);
      const durableEntries = await readdir(durableRoot, { withFileTypes: true });
      expect(durableEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith("task-")).map((entry) => entry.name)).toEqual([first.taskId]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("keeps a ten-runtime establish burst rejection-free during initial reservation", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-runtime-burst-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activators = Array.from({ length: 10 }, () => createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot })));
      const results = await Promise.allSettled(activators.flatMap((activate, runtimeIndex) => Array.from({ length: 10 }, (_, attemptIndex) => activate({
        rawCommand: `@D-AI establish burst runtime ${runtimeIndex} attempt ${attemptIndex}`,
        taskId: null,
      }))));
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      expect(rejected).toEqual([]);
      const responses = results.map((result) => result.status === "fulfilled" ? result.value : null);
      expect(responses.every((result) => result?.status === "accepted" && result.stage === "bootstrap")).toBe(true);
      const taskIds = new Set(responses.map((result) => result?.taskId));
      expect(taskIds.size).toBe(1);
      const store = new FileDurableContextStore(durableRoot);
      const tasks = await store.discoverActiveTasks(workspacePath);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.contextManifest.filter((entry) => entry.startsWith("local-project:"))).toHaveLength(1);
      const durableEntries = await readdir(durableRoot, { withFileTypes: true });
      expect(durableEntries.filter((entry) => entry.isDirectory() && entry.name.startsWith("task-")).map((entry) => entry.name)).toEqual([tasks[0]!.taskId]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks local-only fallback when corrupt Git metadata is present", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-corrupt-git-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      await writeFile(join(workspacePath, ".git"), "gitdir: missing-target\n", "utf8");
      const before = await snapshotFiles(durableRoot);
      const result = await establish(workspacePath, durableRoot, "local project");
      expect(result).toMatchObject({ taskId: "unassigned", status: "blocked" });
      expect(result.message).toMatch(/Git metadata|repository root/i);
      expect(await snapshotFiles(durableRoot)).toEqual(before);
      await expect(access(durableRoot)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generic intent and local-only sync read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-read-only-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const generic = await activate({ rawCommand: "@D-AI inspect current context", taskId: null });
      expect(generic).toMatchObject({ taskId: "unassigned", status: "blocked" });
      expect(generic.message).toMatch(/No active local-only D-AI task/i);
      await expect(access(durableRoot)).rejects.toThrow();

      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      const established = await establish(workspacePath, durableRoot, "local project");
      const beforeSync = await snapshotFiles(durableRoot);
      const synced = await activate({ rawCommand: "@D-AI sync", taskId: established.taskId });
      expect(synced).toMatchObject({ taskId: established.taskId, status: "blocked" });
      expect(synced.message).toMatch(/local-only.*Git backing.*no durable task was created or mutated/i);
      expect(await snapshotFiles(durableRoot)).toEqual(beforeSync);
      const bareSynced = await activate({ rawCommand: "@D-AI sync", taskId: null });
      expect(bareSynced).toMatchObject({ taskId: established.taskId, status: "blocked" });
      expect(bareSynced.message).toMatch(/local-only.*Git backing/i);
      expect(await snapshotFiles(durableRoot)).toEqual(beforeSync);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks zero, multiple, cross-workspace, and exact local-only matches safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-matching-"));
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspaceA, { recursive: true });
      await mkdir(workspaceB, { recursive: true });
      const empty = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: workspaceB, durableRoot }));
      const zero = await empty({ rawCommand: "@D-AI inspect current context", taskId: null });
      expect(zero.taskId).toBe("unassigned");
      const store = new FileDurableContextStore(durableRoot);
      await seedLocalTask(store, workspaceA, "task-local-a", "11111111-1111-4111-8111-111111111111");
      const crossWorkspace = await empty({ rawCommand: "@D-AI inspect current context", taskId: null });
      expect(crossWorkspace.taskId).toBe("unassigned");
      expect(crossWorkspace.message).toMatch(/No active local-only D-AI task/i);

      await seedLocalTask(store, workspaceA, "task-local-b", "22222222-2222-4222-8222-222222222222");
      const activateA = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: workspaceA, durableRoot }));
      const ambiguous = await activateA({ rawCommand: "@D-AI establish local project", taskId: null });
      expect(ambiguous).toMatchObject({ taskId: "ambiguous", status: "blocked" });
      expect(ambiguous.message).toMatch(/Multiple active local-only/i);
      const exact = await activateA({ rawCommand: "@D-AI continue task-local-a", taskId: "task-local-a" });
      expect(exact.taskId).toBe("task-local-a");
      expect(exact.message).not.toMatch(/different workspace/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks local-only establish when another environment already owns the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-other-environment-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const store = new FileDurableContextStore(durableRoot);
      await seedLocalTask(store, workspacePath, "task-work-owned", "55555555-5555-4555-8555-555555555555", "work");
      const before = await snapshotFiles(durableRoot);
      const result = await establish(workspacePath, durableRoot, "local project");
      expect(result).toMatchObject({ taskId: "task-work-owned", status: "blocked" });
      expect(result.message).toMatch(/already match this workspace.*across environments/i);
      expect(await snapshotFiles(durableRoot)).toEqual(before);
      expect(await store.discoverActiveTasks(workspacePath)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks promotion after a valid Git zero-remote local-only task gains a remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-zero-remote-promotion-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await git(null, ["init", "--initial-branch=main", workspacePath]);
      await git(workspacePath, ["config", "user.email", "d-ai@example.test"]);
      await git(workspacePath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(workspacePath, "fixture.txt"), "zero-remote promotion\n", "utf8");
      await git(workspacePath, ["add", "fixture.txt"]);
      await git(workspacePath, ["commit", "-m", "zero-remote promotion"]);
      const first = await establish(workspacePath, durableRoot, "local project");
      expect(first).toMatchObject({ status: "accepted" });
      await git(workspacePath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
      const before = await snapshotFiles(durableRoot);

      const transitioned = await establish(workspacePath, durableRoot, "repository project");
      expect(transitioned).toMatchObject({ taskId: first.taskId, status: "blocked" });
      expect(transitioned.message).toMatch(/automatic promotion|IDENTITY PROMOTION/i);
      expect(await snapshotFiles(durableRoot)).toEqual(before);
      const tasks = await new FileDurableContextStore(durableRoot).discoverActiveTasks(workspacePath);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.contextManifest.filter((entry) => entry.startsWith("local-project:"))).toHaveLength(1);
      expect(tasks[0]?.contextManifest.filter((entry) => entry.startsWith("remote-repository:"))).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks local-only establish beside missing or mixed project identity without mutation", async () => {
    const cases = [
      { suffix: "missing", taskId: "task-missing-project-identity", localProjectId: null, additionalEntries: [] as const },
      { suffix: "mixed", taskId: "task-mixed-project-identity", localProjectId: "66666666-6666-4666-8666-666666666666", additionalEntries: ["remote-repository:github.com/acme/d-ai"] },
    ];
    for (const testCase of cases) {
      const root = await mkdtemp(join(tmpdir(), `d-ai-local-only-invalid-${testCase.suffix}-`));
      const workspacePath = join(root, "workspace");
      const durableRoot = join(root, "durable");
      try {
        await mkdir(workspacePath, { recursive: true });
        const store = new FileDurableContextStore(durableRoot);
        await seedProjectIdentityTask(store, workspacePath, testCase.taskId, testCase.localProjectId, testCase.additionalEntries);
        const before = await snapshotFiles(durableRoot);
        const result = await establish(workspacePath, durableRoot, "local project");
        expect(result).toMatchObject({ taskId: testCase.taskId, status: "blocked" });
        expect(result.message).toMatch(/already match this workspace.*identity states|repository-backed.*no local-only duplicate/i);
        expect(await snapshotFiles(durableRoot)).toEqual(before);
        expect(await store.discoverActiveTasks(workspacePath)).toHaveLength(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  it("blocks local-to-repository promotion without creating a second task", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-transition-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      const first = await establish(workspacePath, durableRoot, "local project");
      await git(null, ["init", "--initial-branch=main", workspacePath]);
      await git(workspacePath, ["config", "user.email", "d-ai@example.test"]);
      await git(workspacePath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(workspacePath, "fixture.txt"), "local-to-repository\n", "utf8");
      await git(workspacePath, ["add", "fixture.txt"]);
      await git(workspacePath, ["commit", "-m", "fixture"]);
      await git(workspacePath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
      const before = await snapshotFiles(durableRoot);
      const transitioned = await establish(workspacePath, durableRoot, "repository project");
      expect(transitioned).toMatchObject({ taskId: first.taskId, status: "blocked" });
      expect(transitioned.message).toMatch(/automatic promotion.*blocked/i);
      expect(await snapshotFiles(durableRoot)).toEqual(before);
      expect(await new FileDurableContextStore(durableRoot).discoverActiveTasks(workspacePath)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps exact local-only curation and Pipeline C bound to the same task", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-pipeline-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory", "memory.sqlite");
    try {
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await git(null, ["init", "--initial-branch=main", workspacePath]);
      await git(workspacePath, ["config", "user.email", "d-ai@example.test"]);
      await git(workspacePath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(workspacePath, "fixture.txt"), "zero-remote recovery boundary\n", "utf8");
      await git(workspacePath, ["add", "fixture.txt"]);
      await git(workspacePath, ["commit", "-m", "zero-remote recovery boundary"]);
      expect(await git(workspacePath, ["remote"])).toBe("");
      const established = await establish(workspacePath, durableRoot, "local project");
      const repeated = await establish(workspacePath, durableRoot, "local project repeated");
      expect(repeated).toMatchObject({ taskId: established.taskId, status: "accepted" });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }));
      const messages = [{ marker: "m-001", text: "Local pipeline checkpoint fact.", observedAt: "2026-09-14T00:00:00.000Z", memoryId: "local-pipeline-fact", subjectKey: "local:pipeline", critical: true }];
      const sourceWindow = {
        sourceType: "conversation" as const,
        sourceKey: "local-only-source",
        projectTaskId: established.taskId,
        messages,
        previousCoveredThroughMarker: null,
        previousBoundarySha256: null,
        sourceStartAttested: true,
        coveredThroughMarker: "m-001",
        boundarySha256: buildCurationBoundarySha256(null, null, messages),
        coverageConfidence: "complete" as const,
      };
      const result = await activate({ rawCommand: "@D-AI 整理", taskId: established.taskId, curationSourceWindow: sourceWindow });
      expect(result, JSON.stringify(result)).toMatchObject({ taskId: established.taskId, status: "completed", curationPipeline: { status: "completed", checkpointAdvanced: true } });
      expect(result.curationPipeline?.currentView?.relevantMemoryIds).toContain("local-pipeline-fact");
      const memoryStore = new LocalSqliteMemoryStore({ databasePath: memoryDatabasePath, workspacePath: dirname(memoryDatabasePath), mode: "writer", scopeId: resolveLocalMemoryScopeId(memoryDatabasePath), writerId: "primary-device" });
      try {
        await expect(memoryStore.listTaskScopedBeliefs(established.taskId, "current")).resolves.toMatchObject([{ memoryId: "local-pipeline-fact", value: { projectTaskId: established.taskId, taskScopeId: established.taskId } }]);
        await expect(memoryStore.listTaskScopedBeliefs(established.taskId, "audit")).resolves.toMatchObject([{ memoryId: "local-pipeline-fact", value: { projectTaskId: established.taskId, taskScopeId: established.taskId } }]);
        await expect(memoryStore.listTaskScopedBeliefs("other-task", "current")).resolves.toEqual([]);
        const rebuilt = await createCurationPipeline({ store: memoryStore, workspacePath: dirname(memoryDatabasePath) }).rebuildCurrentState(established.taskId);
        expect(rebuilt).toMatchObject({ status: "available", safeToDeleteSourceChat: "NO" });
        expect(rebuilt.currentView?.identity).toBe(established.taskId);
      } finally {
        memoryStore.close();
      }
      const task = await new FileDurableContextStore(durableRoot).load(established.taskId);
      expect(await new FileDurableContextStore(durableRoot).discoverActiveTasks(workspacePath)).toHaveLength(1);
      expect(task?.contextManifest.filter((entry) => entry.startsWith("local-project:"))).toHaveLength(1);
      expect(task?.contextManifest.filter((entry) => entry.startsWith("remote-repository:"))).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fall back to local-only when a repository task survives Git root loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-repository-loss-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const store = new FileDurableContextStore(durableRoot);
      await seedRepositoryTask(store, workspacePath, "task-repository-survivor", "github.com/acme/d-ai");
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const before = await snapshotFiles(durableRoot);
      const result = await activate({ rawCommand: "@D-AI establish local project", taskId: null });
      expect(result).toMatchObject({ taskId: "task-repository-survivor", status: "blocked" });
      expect(result.message).toMatch(/repository-backed.*no local-only duplicate/i);
      expect(await snapshotFiles(durableRoot)).toEqual(before);
      expect(await store.discoverActiveTasks(workspacePath)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks every local-only selection path after the workspace obtains Git backing", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-obsolete-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory", "memory.sqlite");
    try {
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      const first = await establish(workspacePath, durableRoot, "local project");
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }));
      await git(null, ["init", "--initial-branch=main", workspacePath]);
      await git(workspacePath, ["config", "user.email", "d-ai@example.test"]);
      await git(workspacePath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(workspacePath, "fixture.txt"), "obsolete local identity\n", "utf8");
      await git(workspacePath, ["add", "fixture.txt"]);
      await git(workspacePath, ["commit", "-m", "fixture"]);
      await git(workspacePath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
      const before = await snapshotFiles(durableRoot);
      const status = await activate({ rawCommand: "@D-AI status", taskId: null });
      expect(status).toMatchObject({ taskId: first.taskId, status: "blocked" });
      expect(status.message).toMatch(/obsolete.*LOCAL.*REPOSITORY.*PROMOTION/i);
      const continued = await activate({ rawCommand: `@D-AI continue ${first.taskId}`, taskId: first.taskId });
      expect(continued).toMatchObject({ taskId: first.taskId, status: "blocked" });
      expect(continued.message).toMatch(/obsolete.*LOCAL.*REPOSITORY.*PROMOTION/i);
      const curated = await activate({
        rawCommand: "@D-AI 整理进我的知识库",
        taskId: first.taskId,
        currentContext: [{
          candidateId: "obsolete-local-fact",
          memoryId: "obsolete-local-fact",
          fact: "This fact must not be curated after Git backing appears.",
          category: "project-memory",
          source: "current-context",
          privacyRisk: "local-private",
          projectTaskId: first.taskId,
        }],
      });
      expect(curated).toMatchObject({ taskId: first.taskId, status: "blocked" });
      expect(curated.message).toMatch(/obsolete.*LOCAL.*REPOSITORY.*PROMOTION/i);
      expect(await snapshotFiles(durableRoot)).toEqual(before);
      await expect(access(memoryDatabasePath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks status selection when the persisted repository conflicts with inspected origin", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-repository-conflict-selection-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      await git(null, ["init", "--initial-branch=main", workspacePath]);
      await git(workspacePath, ["config", "user.email", "d-ai@example.test"]);
      await git(workspacePath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(workspacePath, "fixture.txt"), "repository conflict\n", "utf8");
      await git(workspacePath, ["add", "fixture.txt"]);
      await git(workspacePath, ["commit", "-m", "fixture"]);
      await git(workspacePath, ["remote", "add", "origin", "https://github.com/acme/current.git"]);
      const store = new FileDurableContextStore(durableRoot);
      await seedRepositoryTask(store, workspacePath, "task-repository-conflict", "github.com/acme/other");
      const before = await snapshotFiles(durableRoot);
      const result = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({ rawCommand: "@D-AI status", taskId: null });
      expect(result).toMatchObject({ taskId: "task-repository-conflict", status: "blocked" });
      expect(result.message).toMatch(/repository identity conflicts/i);
      expect(await snapshotFiles(durableRoot)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects recovered local tasks when local-project identity is missing or mismatched", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-local-only-recovery-identity-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const store = new FileDurableContextStore(durableRoot);
      await seedLocalTask(store, workspacePath, "task-local-recovered", "33333333-3333-4333-8333-333333333333");
      await expect(prepareBootstrapTask({ taskId: "task-local-recovered", goal: "Seed task-local-recovered", environment: "codex", workspacePath, repositoryPath: null }, store)).rejects.toThrow(/project identity mismatch/i);
      await expect(prepareBootstrapTask({ taskId: "task-local-recovered", goal: "Seed task-local-recovered", environment: "codex", workspacePath, repositoryPath: null, localProjectId: "44444444-4444-4444-8444-444444444444" }, store)).rejects.toThrow(/project identity mismatch/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
