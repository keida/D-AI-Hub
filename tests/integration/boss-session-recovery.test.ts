import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { prepareBootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { buildCurationBoundarySha256, type CurationPipelineInput } from "../../src/curation/current-view-pipeline.js";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { createConfiguredDAIRuntime } from "../../src/runtime/d-ai-runtime.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";
import { resolveLocalMemoryScopeId } from "../../src/memory/local-memory-path.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

function windowFor(taskId: string): CurationPipelineInput {
  const messages = [
    { marker: "m-001", text: "Milestone: canonical checkpoint verified.", observedAt: "2026-09-17T00:00:00.000Z", subjectKey: "boss:milestone" },
    { marker: "m-002", text: "Current blocker: dependency unavailable.", observedAt: "2026-09-17T00:00:01.000Z", subjectKey: "boss:blocker" },
    { marker: "m-003", text: "Next action: resume canonical work.", observedAt: "2026-09-17T00:00:02.000Z", subjectKey: "boss:next" },
  ] as const;
  return { sourceType: "conversation", sourceKey: "boss-source", projectTaskId: taskId, messages, previousCoveredThroughMarker: null, previousBoundarySha256: null, sourceStartAttested: true, coveredThroughMarker: "m-003", boundarySha256: buildCurationBoundarySha256(null, null, messages), coverageConfidence: "complete" };
}

function oversizedWindowFor(taskId: string): CurationPipelineInput {
  const base = windowFor(taskId);
  const messages = [
    base.messages[0]!,
    base.messages[1]!,
    ...Array.from({ length: 20 }, (_, index) => ({ marker: `m-${String(index + 3).padStart(3, "0")}`, text: `Retained bounded fixture context ${index + 1}.`, observedAt: `2026-09-17T00:00:${String(index + 2).padStart(2, "0")}.000Z`, subjectKey: `boss:retained:${index + 1}` })),
    { marker: "m-023", text: "Next action: resume canonical work.", observedAt: "2026-09-17T00:00:22.000Z", memoryId: "boss-next-v1", subjectKey: "boss:next" },
  ];
  return { ...base, messages, coveredThroughMarker: "m-023", boundarySha256: buildCurationBoundarySha256(null, null, messages) };
}

async function gitWorkspace(root: string, remote: boolean): Promise<void> {
  await runCommand({ command: "git", arguments: ["init", "--initial-branch=main", root], cwd: null });
  await writeFile(join(root, "fixture.txt"), "boss recovery fixture\n", "utf8");
  await runCommand({ command: "git", arguments: ["config", "user.email", "d-ai@example.test"], cwd: root });
  await runCommand({ command: "git", arguments: ["config", "user.name", "D-AI Test"], cwd: root });
  await runCommand({ command: "git", arguments: ["add", "fixture.txt"], cwd: root });
  await runCommand({ command: "git", arguments: ["commit", "-m", "fixture"], cwd: root });
  if (remote) await runCommand({ command: "git", arguments: ["remote", "add", "origin", "https://github.com/acme/d-ai.git"], cwd: root });
}

describe("P4 Boss startup and rollover", () => {
  it.each(["no-git", "zero-remote", "remote"] as const)("recovers the same canonical task and state after restart; project=%s", async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-boss-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      if (mode !== "no-git") await gitWorkspace(workspacePath, mode === "remote");
      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const first = mode === "remote" ? { status: "accepted", taskId: "task-p4-remote" } : await activate({ rawCommand: "@D-AI establish canonical Boss project", taskId: null });
      if (mode === "remote") {
        const store = new FileDurableContextStore(durableRoot);
        const seeded = await prepareBootstrapTask({ taskId: first.taskId, goal: "Seed remote Boss project", environment: "codex", workspacePath, repositoryPath: workspacePath }, store);
        await store.createIfAbsent!({ ...seeded, contextManifest: [...seeded.contextManifest.filter((entry) => !entry.startsWith("remote-repository:")), "remote-repository:github.com/acme/d-ai"] });
      }
      expect(first.status).toBe("accepted");
      const taskId = first.taskId;
      const curated = await activate({ rawCommand: "@D-AI 整理", taskId, curationSourceWindow: windowFor(taskId) });
      expect(curated).toMatchObject({ status: "completed", curationPipeline: { currentView: { verificationStatus: "verified" } } });
      const before = await readFile(join(durableRoot, taskId, "state.json"));
      const fresh = () => createCodexActivation(createConfiguredDAIRuntime(options));
      const startup = await fresh()({ rawCommand: "@D-AI continue", taskId: null });
      const repeated = await fresh()({ rawCommand: "@D-AI continue", taskId: null });
      expect(startup).toMatchObject({ status: "accepted", taskId, bossSession: { decision: "CONTINUE_CURRENT_BOSS", startup: { taskId, phase: null, nextAction: "resume canonical work.", blockers: ["Current blocker: dependency unavailable."], taskAndView: { viewIdentity: taskId, verificationStatus: "verified" }, recovery: { taskId } } } });
      expect(repeated.bossSession?.startup).toEqual(startup.bossSession?.startup);
      expect(startup.bossSession?.project).toMatch(mode === "remote" ? /^github\.com\/acme\/d-ai$/u : /^local-project:/u);
      const ready = await activate({ rawCommand: "@D-AI rollover", taskId, bossSession: { mode: "prepare", sourceKey: "boss-source" } });
      expect(ready).toMatchObject({ status: "accepted", taskId, bossSession: { decision: "ROLLOVER_PREPARED", handoff: { taskId, nextAction: "resume canonical work.", blockers: ["Current blocker: dependency unavailable."], recovery: { taskId } } } });
      const wrongSource = await activate({ rawCommand: "@D-AI rollover", taskId, bossSession: { mode: "prepare", sourceKey: "wrong-source" } });
      expect(wrongSource).toMatchObject({ status: "blocked", taskId, bossSession: { decision: "BLOCKED", handoff: null } });
      const threshold = await activate({ rawCommand: "@D-AI status", taskId, bossSession: { mode: "prepare", signals: { acceptedTicketCount: 10 } } });
      expect(threshold).toMatchObject({ status: "accepted", taskId, bossSession: { decision: "ROLLOVER_RECOMMENDED", triggers: ["accepted-ticket-threshold"], handoff: null } });
      expect(await readFile(join(durableRoot, taskId, "state.json"))).toEqual(before);
      expect((await readdir(durableRoot)).filter((entry) => entry.startsWith("task-"))).toEqual([taskId]);
      expect(await new FileDurableContextStore(durableRoot).discoverActiveTasks(workspacePath)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("fails closed on ambiguous or conflicting task identity without writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-conflict-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const first = await activate({ rawCommand: "@D-AI establish canonical Boss project", taskId: null });
      await activate({ rawCommand: "@D-AI 整理", taskId: first.taskId, curationSourceWindow: windowFor(first.taskId) });
      const store = new FileDurableContextStore(durableRoot);
      const state = await store.load(first.taskId);
      if (state === null) throw new Error("Expected task");
      const snapshot = await readFile(join(durableRoot, first.taskId, "state.json"));
      const mismatch = await activate({ rawCommand: "@D-AI continue", taskId: "task-wrong-project" });
      expect(mismatch).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      await store.createIfAbsent!({ ...state, taskId: "task-p4-duplicate", durableContext: null });
      const ambiguous = await activate({ rawCommand: "@D-AI continue", taskId: null });
      expect(ambiguous).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      expect(await readFile(join(durableRoot, first.taskId, "state.json"))).toEqual(snapshot);
      expect((await readdir(durableRoot)).filter((entry) => entry.startsWith("task-")).sort()).toEqual([first.taskId, "task-p4-duplicate"].sort());
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("bounds rollover references while retaining canonical nextAction and blocker anchors", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-bounded-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }));
      const first = await activate({ rawCommand: "@D-AI establish bounded Boss project", taskId: null });
      const curated = await activate({ rawCommand: "@D-AI 整理", taskId: first.taskId, curationSourceWindow: oversizedWindowFor(first.taskId) });
      expect(curated.status, curated.message).toBe("completed");
      const ready = await activate({ rawCommand: "@D-AI rollover", taskId: first.taskId, bossSession: { mode: "prepare", sourceKey: "boss-source" } });
      expect(ready).toMatchObject({ status: "accepted", bossSession: { decision: "ROLLOVER_PREPARED", handoff: { nextAction: "resume canonical work.", blockers: ["Current blocker: dependency unavailable."] } } });
      const context = ready.bossSession?.handoff;
      expect(context?.projection.authoritativeReferenceCount).toBeGreaterThan(16);
      expect(context?.projection.selectedReferenceCount).toBe(16);
      expect(context?.projection.omittedReferenceCount).toBeGreaterThan(0);
      expect(context?.taskAndView.relevantMemoryIds).toHaveLength(16);
      expect(context?.taskAndView.relevantMemoryIds).toContain("boss-next-v1");
      const restarted = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }))({ rawCommand: "@D-AI continue", taskId: null });
      expect(restarted).toMatchObject({ status: "accepted", taskId: first.taskId, bossSession: { startup: { projection: { authoritative: true, omittedReferenceCount: 0 } } } });
      expect(restarted.bossSession?.startup?.taskAndView.relevantMemoryIds).toHaveLength(context!.projection.authoritativeReferenceCount);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("rejects cross-project recovery even when a task ID is supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-cross-project-"));
    const firstPath = join(root, "first");
    const secondPath = join(root, "second");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(firstPath, { recursive: true });
      await mkdir(secondPath, { recursive: true });
      const first = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath: firstPath, durableRoot }))({ rawCommand: "@D-AI establish first project", taskId: null });
      const second = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: secondPath, durableRoot }));
      const result = await second({ rawCommand: "@D-AI continue", taskId: first.taskId });
      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      expect(await new FileDurableContextStore(durableRoot).discoverActiveTasks(firstPath)).toHaveLength(1);
      expect(await new FileDurableContextStore(durableRoot).discoverActiveTasks(secondPath)).toHaveLength(0);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("does not hand off a stale checkpoint after a newer authoritative belief", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-stale-checkpoint-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const first = await activate({ rawCommand: "@D-AI establish stale checkpoint fixture", taskId: null });
      await expect(activate({ rawCommand: "@D-AI 整理", taskId: first.taskId, curationSourceWindow: windowFor(first.taskId) })).resolves.toMatchObject({ status: "completed" });
      const memoryStore = new LocalSqliteMemoryStore({ databasePath: memoryDatabasePath, workspacePath: dirname(memoryDatabasePath), mode: "writer", scopeId: resolveLocalMemoryScopeId(memoryDatabasePath), writerId: "primary-device" });
      try {
        await memoryStore.applyMutations([{ operation: "add", memoryId: "boss-newer-constraint", value: { kind: "curated-fact", fact: "Local constraint is retained.", category: "project-memory", topicLabel: "workflow/process", critical: true, projectTaskId: first.taskId, taskScopeId: first.taskId, subjectKey: "boss:newer-constraint", revision: 1, observedAt: "2026-09-17T00:00:04.000Z", supersedesMemoryIds: [], evidenceRefs: [], assetRefs: [] }, recordedAt: "2026-09-17T00:00:04.000Z" }]);
      } finally { memoryStore.close(); }
      const startup = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI continue", taskId: null });
      expect(startup).toMatchObject({ status: "accepted", taskId: first.taskId, bossSession: { currentStateVersion: null, checkpointReference: null, startup: { limitations: ["Local constraint is retained."], nextAction: "resume canonical work.", recovery: { taskId: first.taskId, currentStateVersion: null, checkpointReference: null } } } });
      const prepare = await activate({ rawCommand: "@D-AI rollover", taskId: first.taskId, bossSession: { mode: "prepare", sourceKey: "boss-source" } });
      expect(prepare).toMatchObject({ status: "blocked", taskId: first.taskId, bossSession: { decision: "BLOCKED", handoff: null } });
      expect(prepare.message).toMatch(/checkpoint metadata/i);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("fails closed when project identity is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-missing-identity-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const first = await activate({ rawCommand: "@D-AI establish identity fixture", taskId: null });
      const store = new FileDurableContextStore(durableRoot);
      const state = await store.load(first.taskId);
      if (state === null) throw new Error("Expected task");
      await store.withTaskOwnership(state.taskId, "codex", async (lease) => store.save({ ...state, contextManifest: state.contextManifest.filter((entry) => !entry.startsWith("local-project:")) }, lease));
      const before = await readFile(join(durableRoot, state.taskId, "state.json"));
      const result = await activate({ rawCommand: "@D-AI continue", taskId: null });
      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      expect(await readFile(join(durableRoot, state.taskId, "state.json"))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("rejects an active task for the same workspace in another environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-cross-environment-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const first = await activate({ rawCommand: "@D-AI establish environment fixture", taskId: null });
      const store = new FileDurableContextStore(durableRoot);
      const state = await store.load(first.taskId);
      if (state === null) throw new Error("Expected task");
      await store.createIfAbsent!({ ...state, taskId: "task-p4-other-environment", environment: "work", durableContext: null });
      const result = await activate({ rawCommand: "@D-AI continue", taskId: first.taskId });
      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      expect((await readdir(durableRoot)).filter((entry) => entry.startsWith("task-")).sort()).toEqual([first.taskId, "task-p4-other-environment"].sort());
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("does not select a valid task beside a malformed active project identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-malformed-neighbor-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const first = await activate({ rawCommand: "@D-AI establish valid identity fixture", taskId: null });
      const store = new FileDurableContextStore(durableRoot);
      const state = await store.load(first.taskId);
      if (state === null) throw new Error("Expected task");
      await store.createIfAbsent!({ ...state, taskId: "task-p4-malformed-neighbor", contextManifest: state.contextManifest.filter((entry) => !entry.startsWith("local-project:")), durableContext: null });
      const result = await activate({ rawCommand: "@D-AI continue", taskId: first.taskId });
      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      expect((await readdir(durableRoot)).filter((entry) => entry.startsWith("task-")).sort()).toEqual([first.taskId, "task-p4-malformed-neighbor"].sort());
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });
});
