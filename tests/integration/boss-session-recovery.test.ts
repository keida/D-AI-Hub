import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
    { marker: "m-004", text: "Current phase: pilot verification", observedAt: "2026-09-17T00:00:03.000Z", subjectKey: "boss:phase" },
  ] as const;
  return { sourceType: "conversation", sourceKey: "boss-source", projectTaskId: taskId, messages, previousCoveredThroughMarker: null, previousBoundarySha256: null, sourceStartAttested: true, coveredThroughMarker: "m-004", boundarySha256: buildCurationBoundarySha256(null, null, messages), coverageConfidence: "complete" };
}

function oversizedWindowFor(taskId: string): CurationPipelineInput {
  const base = windowFor(taskId);
  const messages = [
    base.messages[0]!,
    base.messages[1]!,
    ...Array.from({ length: 20 }, (_, index) => ({ marker: `m-${String(index + 3).padStart(3, "0")}`, text: `Retained bounded fixture context ${index + 1}.`, observedAt: `2026-09-17T00:00:${String(index + 2).padStart(2, "0")}.000Z`, subjectKey: `boss:retained:${index + 1}` })),
    { marker: "m-023", text: "Next action: resume canonical work.", observedAt: "2026-09-17T00:00:22.000Z", memoryId: "boss-next-v1", subjectKey: "boss:next" },
    { marker: "m-024", text: "Current phase: pilot verification", observedAt: "2026-09-17T00:00:23.000Z", subjectKey: "boss:phase" },
  ];
  return { ...base, messages, coveredThroughMarker: "m-024", boundarySha256: buildCurationBoundarySha256(null, null, messages) };
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

async function detachedRemoteWorkspace(workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
  await gitWorkspace(workspacePath, true);
  await runCommand({ command: "git", arguments: ["checkout", "--detach", "HEAD"], cwd: workspacePath });
}

async function seedRemoteTask(store: FileDurableContextStore, taskId: string, workspacePath: string, environment: "codex" | "work" = "codex") {
  const seeded = await prepareBootstrapTask({ taskId, goal: `Seed ${taskId}`, environment, workspacePath, repositoryPath: workspacePath }, store);
  const state = { ...seeded, contextManifest: [...seeded.contextManifest.filter((entry) => !entry.startsWith("remote-repository:")), "remote-repository:github.com/acme/d-ai"] };
  await store.createIfAbsent!(state);
  return state;
}

async function logicalTaskSnapshot(store: FileDurableContextStore, durableRoot: string): Promise<{
  readonly taskIds: readonly string[];
  readonly taskStates: readonly { taskId: string; state: unknown }[];
  readonly durableFiles: Readonly<Record<string, string>>;
}> {
  const taskIds = (await readdir(durableRoot)).filter((entry) => entry.startsWith("task-")).sort();
  const taskStates = await Promise.all(taskIds.map(async (taskId) => ({ taskId, state: await store.load(taskId) })));
  const durableFiles: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) durableFiles[relative(durableRoot, path)] = (await readFile(path)).toString("base64");
    }
  };
  await visit(durableRoot);
  return { taskIds, taskStates, durableFiles };
}

describe("P4 Boss startup and rollover", () => {
  it.each([
    { project: "DSH 2", messageCount: 3, missingFields: ["phase"], canonicalNextAction: "resume canonical work." },
    { project: "Weekly Review", messageCount: 2, missingFields: ["phase", "nextAction"], canonicalNextAction: null },
  ])("returns typed INCOMPLETE without a Boss projection for $project shaped state", async ({ messageCount, missingFields, canonicalNextAction }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-recovery-incomplete-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }));
      const established = await activate({ rawCommand: "@D-AI establish incomplete recovery fixture", taskId: null });
      const source = windowFor(established.taskId);
      const messages = source.messages.slice(0, messageCount);
      const curated = await activate({ rawCommand: "@D-AI 整理", taskId: established.taskId, curationSourceWindow: {
        ...source, messages, coveredThroughMarker: messages.at(-1)!.marker, boundarySha256: buildCurationBoundarySha256(null, null, messages),
      } });
      expect(curated.status).toBe("completed");
      const before = await readFile(join(durableRoot, established.taskId, "state.json"));
      const startup = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }))({ rawCommand: "@D-AI continue", taskId: null });
      expect(startup).toMatchObject({ status: "blocked", taskId: established.taskId, bossSession: {
        decision: "BLOCKED", phase: null, nextAction: null, startup: null, handoff: null,
        recoveryCompleteness: { status: "INCOMPLETE", missingFields, projection: "UNAVAILABLE", canonicalNextAction, diagnosticReason: expect.stringContaining("missing fields") },
      } });
      expect(await readFile(join(durableRoot, established.taskId, "state.json"))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

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
      expect(startup).toMatchObject({ status: "accepted", taskId, bossSession: { decision: "CONTINUE_CURRENT_BOSS", recoveryCompleteness: { status: "COMPLETE", projection: "AVAILABLE" }, startup: { taskId, phase: "pilot verification", nextAction: "resume canonical work.", blockers: ["Current blocker: dependency unavailable."], taskAndView: { viewIdentity: taskId, verificationStatus: "verified" }, recovery: { taskId } } } });
      expect(repeated.bossSession?.startup).toEqual(startup.bossSession?.startup);
      expect(startup.bossSession?.project).toMatch(mode === "remote" ? /^github\.com\/acme\/d-ai$/u : /^local-project:/u);
      const ready = await activate({ rawCommand: "@D-AI rollover", taskId, bossSession: { mode: "prepare", sourceKey: "boss-source" } });
      expect(ready).toMatchObject({ status: "accepted", taskId, bossSession: { decision: "ROLLOVER_PREPARED", handoff: { taskId, nextAction: "resume canonical work.", blockers: ["Current blocker: dependency unavailable."], recovery: { taskId } } } });
      const wrongSource = await activate({ rawCommand: "@D-AI rollover", taskId, bossSession: { mode: "prepare", sourceKey: "wrong-source" } });
      expect(wrongSource).toMatchObject({ status: "blocked", taskId, bossSession: { decision: "BLOCKED", handoff: null, recoveryCompleteness: { status: "COMPLETE", projection: "AVAILABLE" } } });
      const threshold = await activate({ rawCommand: "@D-AI status", taskId, bossSession: { mode: "prepare", signals: { acceptedTicketCount: 10 } } });
      expect(threshold).toMatchObject({ status: "accepted", taskId, bossSession: { decision: "ROLLOVER_RECOMMENDED", triggers: ["accepted-ticket-threshold"], handoff: null } });
      expect(await readFile(join(durableRoot, taskId, "state.json"))).toEqual(before);
      expect((await readdir(durableRoot)).filter((entry) => entry.startsWith("task-"))).toEqual([taskId]);
      expect(await new FileDurableContextStore(durableRoot).discoverActiveTasks(workspacePath)).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("keeps configured repository identity and Boss recovery available after detaching the synthetic worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-identity-baseline-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await gitWorkspace(workspacePath, true);
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }));
      const taskId = "task-p4-detached-identity";
      const store = new FileDurableContextStore(durableRoot);
      const seeded = await prepareBootstrapTask({ taskId, goal: "Seed detached identity fixture", environment: "codex", workspacePath, repositoryPath: workspacePath }, store);
      await store.createIfAbsent!({ ...seeded, contextManifest: [...seeded.contextManifest.filter((entry) => !entry.startsWith("remote-repository:")), "remote-repository:github.com/acme/d-ai"] });
      const curated = await activate({ rawCommand: "@D-AI 整理", taskId, curationSourceWindow: windowFor(taskId) });
      expect(curated.status, curated.message).toBe("completed");

      const attachedStatus = await activate({
        rawCommand: "@D-AI status",
        taskId,
        bossSession: { mode: "prepare", signals: { acceptedTicketCount: 0 } },
      });
      expect(attachedStatus.status).toBe("accepted");
      expect(attachedStatus.bossSession?.project).toBe("github.com/acme/d-ai");

      await runCommand({ command: "git", arguments: ["checkout", "--detach", "HEAD"], cwd: workspacePath });
      const detachedStatus = await activate({
        rawCommand: "@D-AI status",
        taskId,
        bossSession: { mode: "prepare", signals: { acceptedTicketCount: 0 } },
      });
      const detachedRollover = await activate({
        rawCommand: "@D-AI rollover",
        taskId,
        bossSession: { mode: "prepare", sourceKey: "boss-source" },
      });

      expect({ detachedStatus, detachedRollover }).toMatchObject({
        detachedStatus: { status: "accepted", bossSession: { project: "github.com/acme/d-ai" } },
        detachedRollover: { status: "accepted", bossSession: { decision: "ROLLOVER_PREPARED" } },
      });
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("routes ordinary status and rollover by repository identity from a linked detached workspace without task or fact resubmission", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-linked-detached-ordinary-routing-"));
    const sourcePath = join(root, "source");
    const workspacePath = join(root, "linked-workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    const taskId = "task-p4-linked-detached-ordinary";
    try {
      await mkdir(sourcePath, { recursive: true });
      await gitWorkspace(sourcePath, true);
      await runCommand({ command: "git", arguments: ["worktree", "add", "--detach", workspacePath, "HEAD"], cwd: sourcePath });
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      const store = new FileDurableContextStore(durableRoot);
      const seeded = await prepareBootstrapTask({ taskId, goal: "Seed linked detached ordinary routing", environment: "codex", workspacePath, repositoryPath: workspacePath }, store);
      await store.createIfAbsent!({ ...seeded, contextManifest: [...seeded.contextManifest.filter((entry) => !entry.startsWith("remote-repository:")), "remote-repository:github.com/acme/d-ai"] });
      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const curated = await activate({ rawCommand: "@D-AI 整理", taskId, curationSourceWindow: windowFor(taskId) });
      expect(curated.status, curated.message).toBe("completed");

      const ordinaryStatus = await activate({ rawCommand: "@D-AI status", taskId: null });

      expect(ordinaryStatus).toMatchObject({ status: "accepted", taskId, environment: "codex" });
      const durableBeforeRollover = await logicalTaskSnapshot(store, durableRoot);
      const freshActivation = createCodexActivation(createConfiguredDAIRuntime(options));
      const ordinaryRollover = await freshActivation({ rawCommand: "@D-AI rollover", taskId: null });

      expect(ordinaryRollover).toMatchObject({
        status: "accepted",
        taskId,
        bossSession: { decision: "ROLLOVER_PREPARED", project: "github.com/acme/d-ai", handoff: { taskId } },
      });
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(durableBeforeRollover);
    } finally {
      await runCommand({ command: "git", arguments: ["worktree", "remove", "--force", workspacePath], cwd: sourcePath }).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("does not create or select a task for an otherwise valid detached remote workspace with no task", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-remote-no-task-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await detachedRemoteWorkspace(workspacePath);
      await mkdir(durableRoot, { recursive: true });
      const store = new FileDurableContextStore(durableRoot);
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
      const before = await logicalTaskSnapshot(store, durableRoot);

      const result = await activate({ rawCommand: "@D-AI continue", taskId: null });

      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED", recoveryCompleteness: { status: "BLOCKED", projection: "UNAVAILABLE" } } });
      expect(result.message).toMatch(/task|canonical|workspace/i);
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("keeps a linked sibling workspace isolated even when its detached remote resolves to the same repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-remote-sibling-"));
    const sourcePath = join(root, "source");
    const taskWorkspace = join(root, "task-worktree");
    const siblingWorkspace = join(root, "sibling-worktree");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(sourcePath, { recursive: true });
      await gitWorkspace(sourcePath, true);
      await runCommand({ command: "git", arguments: ["worktree", "add", "--detach", taskWorkspace, "HEAD"], cwd: sourcePath });
      await runCommand({ command: "git", arguments: ["worktree", "add", "--detach", siblingWorkspace, "HEAD"], cwd: sourcePath });
      await mkdir(join(taskWorkspace, ".agents", "skills"), { recursive: true });
      await mkdir(join(siblingWorkspace, ".agents", "skills"), { recursive: true });
      const store = new FileDurableContextStore(durableRoot);
      const taskId = "task-p4-sibling-worktree-owner";
      await seedRemoteTask(store, taskId, taskWorkspace);
      const before = await logicalTaskSnapshot(store, durableRoot);
      const siblingIdentity = await runCommand({ command: "git", arguments: ["remote", "get-url", "origin"], cwd: siblingWorkspace });
      expect(siblingIdentity.stdout.trim()).toBe("https://github.com/acme/d-ai.git");

      const result = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath: siblingWorkspace, durableRoot }))({ rawCommand: "@D-AI status", taskId });

      expect(result).toMatchObject({ status: "blocked", taskId, message: expect.stringMatching(/different workspace/i) });
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(before);
    } finally {
      await runCommand({ command: "git", arguments: ["worktree", "remove", "--force", taskWorkspace], cwd: sourcePath }).catch(() => {});
      await runCommand({ command: "git", arguments: ["worktree", "remove", "--force", siblingWorkspace], cwd: sourcePath }).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("blocks detached-remote recovery across environment ownership without changing task records", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-remote-environment-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await detachedRemoteWorkspace(workspacePath);
      const store = new FileDurableContextStore(durableRoot);
      const taskId = "task-p4-detached-other-environment";
      await seedRemoteTask(store, taskId, workspacePath, "work");
      const before = await logicalTaskSnapshot(store, durableRoot);

      const result = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({ rawCommand: "@D-AI continue", taskId: null });

      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("blocks multiple matching detached-remote tasks without choosing, mutating, or creating one", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-remote-ambiguous-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await detachedRemoteWorkspace(workspacePath);
      const store = new FileDurableContextStore(durableRoot);
      await seedRemoteTask(store, "task-p4-detached-duplicate-a", workspacePath);
      await seedRemoteTask(store, "task-p4-detached-duplicate-b", workspacePath);
      const before = await logicalTaskSnapshot(store, durableRoot);

      const result = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({ rawCommand: "@D-AI continue", taskId: null });

      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED", recoveryCompleteness: { missingFields: [] } } });
      expect(result.message).toMatch(/exactly one|identity conflicts/i);
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("preserves historical-only and incomplete recovery semantics on a detached configured remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-remote-dispositions-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await detachedRemoteWorkspace(workspacePath);
      const store = new FileDurableContextStore(durableRoot);
      const frozenTaskId = "task-p4-detached-frozen-only";
      const frozen = { ...await seedRemoteTask(store, frozenTaskId, workspacePath), routingDisposition: "LEGACY_FROZEN" as const };
      await store.withTaskOwnership(frozenTaskId, "codex", (lease) => store.save(frozen, lease));
      const before = await logicalTaskSnapshot(store, durableRoot);
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));

      const current = await activate({ rawCommand: "@D-AI continue", taskId: null });
      const historical = await activate({ rawCommand: "@D-AI status", taskId: frozenTaskId });

      expect(current).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED" } });
      expect(historical).toMatchObject({ status: "accepted", taskId: frozenTaskId });
      expect(historical.message).toMatch(/LEGACY_FROZEN|historical/i);
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("reports incomplete detached-remote recovery without inventing projection or handoff data", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-remote-incomplete-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await detachedRemoteWorkspace(workspacePath);
      const store = new FileDurableContextStore(durableRoot);
      const taskId = "task-p4-detached-incomplete";
      await seedRemoteTask(store, taskId, workspacePath);
      const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot, memoryDatabasePath }));
      const source = windowFor(taskId);
      const messages = source.messages.slice(0, 2);
      await activate({ rawCommand: "@D-AI 整理", taskId, curationSourceWindow: {
        ...source,
        messages,
        coveredThroughMarker: messages.at(-1)!.marker,
        boundarySha256: buildCurationBoundarySha256(null, null, messages),
      } });
      const before = await logicalTaskSnapshot(store, durableRoot);

      const result = await activate({ rawCommand: "@D-AI continue", taskId: null });

      expect(result).toMatchObject({
        status: "blocked",
        taskId,
        bossSession: { decision: "BLOCKED", project: null, handoff: null, recoveryCompleteness: { status: "INCOMPLETE", projection: "UNAVAILABLE", diagnosticReason: expect.stringContaining("missing fields") } },
      });
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("fails closed for an unsupported configured remote URL without changing the canonical task", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-detached-remote-unsupported-url-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    try {
      await detachedRemoteWorkspace(workspacePath);
      const store = new FileDurableContextStore(durableRoot);
      const taskId = "task-p4-detached-unsupported-url";
      await seedRemoteTask(store, taskId, workspacePath);
      await runCommand({ command: "git", arguments: ["config", "remote.origin.url", "file:///tmp/not-a-github-repository"], cwd: workspacePath });
      const before = await logicalTaskSnapshot(store, durableRoot);

      const result = await createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({ rawCommand: "@D-AI continue", taskId: null });

      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED", recoveryCompleteness: { status: "BLOCKED", projection: "UNAVAILABLE" } } });
      expect(await logicalTaskSnapshot(store, durableRoot)).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it("starts from the sole eligible task while retaining a legacy-frozen historical task", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4-routing-disposition-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const established = await activate({ rawCommand: "@D-AI establish routing disposition fixture", taskId: null });
      await activate({ rawCommand: "@D-AI 整理", taskId: established.taskId, curationSourceWindow: windowFor(established.taskId) });

      const store = new FileDurableContextStore(durableRoot);
      const routable = await store.load(established.taskId);
      if (routable === null) throw new Error("Expected established routing task");
      const frozenTaskId = "task-routing-legacy-frozen";
      await store.createIfAbsent!({
        ...routable,
        taskId: frozenTaskId,
        environment: "work",
        routingDisposition: "LEGACY_FROZEN",
        durableContext: null,
      });
      const before = await readFile(join(durableRoot, established.taskId, "state.json"));

      const startup = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI continue", taskId: null });

      expect(startup).toMatchObject({
        status: "accepted",
        taskId: established.taskId,
        bossSession: { decision: "CONTINUE_CURRENT_BOSS", startup: { taskId: established.taskId } },
      });
      expect((await store.load(frozenTaskId))?.routingDisposition).toBe("LEGACY_FROZEN");
      expect(await readFile(join(durableRoot, established.taskId, "state.json"))).toEqual(before);
      expect(await store.discoverActiveTasks(workspacePath)).toHaveLength(2);
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
      expect(prepare).toMatchObject({ status: "blocked", taskId: first.taskId, bossSession: { decision: "BLOCKED", handoff: null, recoveryCompleteness: { status: "COMPLETE", projection: "AVAILABLE" } } });
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
      expect(result).toMatchObject({ status: "blocked", bossSession: { decision: "BLOCKED", recoveryCompleteness: { status: "BLOCKED", missingFields: ["project-identity"], projection: "UNAVAILABLE" } } });
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

  it("keeps typed completeness COMPLETE when the existing P4 blocker display bound blocks startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-complete-p4-bound-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const established = await activate({ rawCommand: "@D-AI establish complete recovery fixture", taskId: null });
      expect(established.status).toBe("accepted");
      const curated = await activate({ rawCommand: "@D-AI 整理", taskId: established.taskId, curationSourceWindow: windowFor(established.taskId) });
      expect(curated.status).toBe("completed");
      const writer = new LocalSqliteMemoryStore({ databasePath: memoryDatabasePath, workspacePath: dirname(memoryDatabasePath), mode: "writer", scopeId: resolveLocalMemoryScopeId(memoryDatabasePath), writerId: "primary-device" });
      try {
        await writer.applyMutations(Array.from({ length: 16 }, (_, index) => ({ operation: "add" as const, memoryId: `extra-blocker-${index}`, value: { kind: "curated-fact", fact: `Current blocker: external dependency ${index}.`, category: "project-memory", topicLabel: "bug/root-cause", critical: true, projectTaskId: established.taskId, taskScopeId: established.taskId, subjectKey: `extra:blocker:${index}`, revision: 1, observedAt: "2026-09-17T00:00:04.000Z", supersedesMemoryIds: [], evidenceRefs: [], assetRefs: [] }, recordedAt: "2026-09-17T00:00:04.000Z" })));
      } finally { writer.close(); }
      const before = await readFile(join(durableRoot, established.taskId, "state.json"));
      const result = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI continue", taskId: null });
      expect(result).toMatchObject({ status: "blocked", taskId: established.taskId, bossSession: { decision: "BLOCKED", startup: null, recoveryCompleteness: { status: "COMPLETE", missingFields: [], projection: "AVAILABLE" } } });
      expect(await readFile(join(durableRoot, established.taskId, "state.json"))).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });

  it.each(["trailing-space", "aggregate-overflow"] as const)("keeps authoritative limitations recoverable through bounded Boss context: %s", async (caseName) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p4r-limitations-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath, { recursive: true });
      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const first = await activate({ rawCommand: "@D-AI establish bounded limitations project", taskId: null });
      expect(first.status).toBe("accepted");
      const facts = caseName === "trailing-space"
        ? [`${"L".repeat(255)} continuation`]
        : Array.from({ length: 10 }, (_, index) => `Constraint ${index}: ${"X".repeat(230)}`);
      const store = new LocalSqliteMemoryStore({ databasePath: memoryDatabasePath, workspacePath: dirname(memoryDatabasePath), mode: "writer", scopeId: resolveLocalMemoryScopeId(memoryDatabasePath), writerId: "primary-device" });
      try {
        await store.applyMutations(facts.map((fact, index) => ({ operation: "add" as const, memoryId: `p4r-limitation-${index}`, value: { kind: "curated-fact", fact, category: "project-memory", topicLabel: "workflow/process", critical: true, projectTaskId: first.taskId, taskScopeId: first.taskId, subjectKey: `p4r:${index}`, revision: 1, observedAt: "2026-09-17T00:00:00.000Z", supersedesMemoryIds: [], evidenceRefs: [], assetRefs: [] }, recordedAt: "2026-09-17T00:00:00.000Z" })));
      } finally { store.close(); }
      const curated = await activate({ rawCommand: "@D-AI 整理", taskId: first.taskId, curationSourceWindow: windowFor(first.taskId) });
      expect(curated.status, curated.message).toBe("completed");
      const beforeState = await readFile(join(durableRoot, first.taskId, "state.json"));
      const fresh = () => createCodexActivation(createConfiguredDAIRuntime(options));
      const startup = await fresh()({ rawCommand: "@D-AI continue", taskId: null });
      const repeated = await fresh()({ rawCommand: "@D-AI continue", taskId: null });
      expect(startup).toMatchObject({ status: "accepted", taskId: first.taskId, bossSession: { decision: "CONTINUE_CURRENT_BOSS", startup: { recovery: { taskId: first.taskId }, nextAction: "resume canonical work." } } });
      expect(repeated.bossSession?.startup).toEqual(startup.bossSession?.startup);
      const presentation = startup.bossSession?.startup?.limitationsPresentation;
      expect(presentation?.totalCount).toBe(facts.length);
      if (caseName === "trailing-space") {
        expect(startup.bossSession?.startup?.limitations).toEqual(["L".repeat(255)]);
        expect(presentation).toMatchObject({ inlineCount: 1, omittedCount: 0, truncatedCount: 1, truncatedMemoryIds: ["p4r-limitation-0"] });
      } else {
        expect(presentation?.omittedCount).toBeGreaterThan(0);
        expect(presentation?.omittedMemoryIds.length).toBe(presentation?.omittedCount);
        expect(Buffer.byteLength(JSON.stringify(startup.bossSession?.startup?.limitations), "utf8")).toBeLessThanOrEqual(2048);
      }
      const rollover = await activate({ rawCommand: "@D-AI rollover", taskId: first.taskId, bossSession: { mode: "prepare", sourceKey: "boss-source" } });
      expect(rollover).toMatchObject({ status: "accepted", taskId: first.taskId, bossSession: { decision: "ROLLOVER_PREPARED", handoff: { recovery: { taskId: first.taskId }, limitationsPresentation: { totalCount: facts.length } } } });
      expect(await readFile(join(durableRoot, first.taskId, "state.json"))).toEqual(beforeState);
      const reader = new LocalSqliteMemoryStore({ databasePath: memoryDatabasePath, workspacePath: dirname(memoryDatabasePath), mode: "reader", scopeId: resolveLocalMemoryScopeId(memoryDatabasePath), writerId: "primary-device" });
      try {
        const records = await reader.listTaskScopedBeliefs(first.taskId, "current", 256);
        for (const fact of facts) expect(records.some((record) => typeof record.value === "object" && record.value !== null && "fact" in record.value && record.value.fact === fact)).toBe(true);
      } finally { reader.close(); }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }); }
  });
});
