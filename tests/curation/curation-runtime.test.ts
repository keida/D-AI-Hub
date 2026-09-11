import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { createConfiguredDAIRuntime } from "../../src/runtime/d-ai-runtime.js";
import type { TaskState } from "../../src/domain/types.js";
import { runCommand } from "../../src/adapters/command-runner.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";
import { resolveLocalMemoryScopeId } from "../../src/memory/local-memory-path.js";
import { dirname } from "node:path";

const temporaryRoots: string[] = [];

async function prepareGitWorkspace(root: string): Promise<void> {
  await runCommand({ command: "git", arguments: ["init", "--initial-branch=main", root], cwd: null });
  await writeFile(join(root, "fixture.txt"), "curation fixture\n", "utf8");
  await runCommand({ command: "git", arguments: ["config", "user.email", "d-ai@example.test"], cwd: root });
  await runCommand({ command: "git", arguments: ["config", "user.name", "D-AI Test"], cwd: root });
  await runCommand({ command: "git", arguments: ["add", "fixture.txt"], cwd: root });
  await runCommand({ command: "git", arguments: ["commit", "-m", "curation fixture"], cwd: root });
  await runCommand({ command: "git", arguments: ["remote", "add", "origin", "https://github.com/acme/d-ai.git"], cwd: root });
}

function seededTask(root: string, taskId: string): TaskState {
  const identityHash = createHash("sha256").update(root, "utf8").digest("hex");
  return {
    taskId,
    goal: "Seed an exact project identity for curation",
    constraints: [],
    environment: "codex",
    stage: "bootstrap",
    role: "analyst",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: [`identity:workspace:${root}:${identityHash}`, "remote-repository:github.com/acme/d-ai"],
    handoffState: "none",
    verificationEvidence: [],
    recoveryPoint: null,
    approvalState: "not-required",
    criticalUnsavedContext: [],
    durableContext: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("configured curation runtime", () => {
  it("defers without context and does not create a durable task", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-"));
    temporaryRoots.push(root);
    const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: root }));

    const result = await activate({ rawCommand: "@D-AI 整理", taskId: null });

    expect(result).toMatchObject({ status: "blocked", taskId: "unassigned" });
    expect(result.message).toMatch(/SAFE TO DELETE ORIGINAL CHAT: NO|not captured/i);
    await expect(access(join(root, ".d-ai"))).rejects.toThrow();
  });

  it("uses the supplied exact project identity without reading or creating durable task state", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-"));
    temporaryRoots.push(root);
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-db-"));
    temporaryRoots.push(databaseRoot);
    const databasePath = join(databaseRoot, "memory.sqlite");
    await mkdir(join(root, ".agents"), { recursive: true });
    await runCommand({ command: "git", arguments: ["init", "--initial-branch=main", root], cwd: null });
    await writeFile(join(root, "fixture.txt"), "curation fixture\n", "utf8");
    await runCommand({ command: "git", arguments: ["config", "user.email", "d-ai@example.test"], cwd: root });
    await runCommand({ command: "git", arguments: ["config", "user.name", "D-AI Test"], cwd: root });
    await runCommand({ command: "git", arguments: ["add", "fixture.txt"], cwd: root });
    await runCommand({ command: "git", arguments: ["commit", "-m", "curation fixture"], cwd: root });
    await runCommand({ command: "git", arguments: ["remote", "add", "origin", "https://github.com/acme/d-ai.git"], cwd: root });
    const taskId = "task-937dc8b8c2a683764bc3eb62";
    const identityHash = createHash("sha256").update(root, "utf8").digest("hex");
    const durableStore = new FileDurableContextStore(join(root, ".d-ai"));
    const state: TaskState = {
      taskId,
      goal: "Seed an exact project identity for curation",
      constraints: [],
      environment: "codex",
      stage: "bootstrap",
      role: "analyst",
      routingDecision: null,
      selectedCapabilities: [],
      contextManifest: [`identity:workspace:${root}:${identityHash}`, "remote-repository:github.com/acme/d-ai"],
      handoffState: "none",
      verificationEvidence: [],
      recoveryPoint: null,
      approvalState: "not-required",
      criticalUnsavedContext: [],
      durableContext: null,
    };
    await durableStore.createIfAbsent(state);
    const beforeCuration = await durableStore.load(taskId);
    const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: root, memoryDatabasePath: databasePath }));

    const result = await activate({
      rawCommand: "@D-AI 整理进我的知识库",
      taskId,
      currentContext: [{
        candidateId: "project-fact",
        memoryId: "project-fact",
        fact: "The accepted local runtime is the canonical execution root.",
        category: "project-memory",
        source: "current-context",
        privacyRisk: "local-private",
        projectTaskId: taskId,
      }],
    });

    expect(result, JSON.stringify(result)).toMatchObject({ status: "completed", taskId: "task-937dc8b8c2a683764bc3eb62" });
    expect(result.message).toMatch(/Added=1|locally stored=YES/i);
    expect(await durableStore.load(taskId)).toEqual(beforeCuration);
    await expect(access(databasePath)).resolves.toBeUndefined();
  });

  it("defers project-memory when no exact current workspace task exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-zero-task-"));
    temporaryRoots.push(root);
    await prepareGitWorkspace(root);
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-zero-db-"));
    temporaryRoots.push(databaseRoot);
    const databasePath = join(databaseRoot, "memory.sqlite");
    const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: root, memoryDatabasePath: databasePath }));

    const result = await activate({
      rawCommand: "@D-AI 整理",
      taskId: null,
      currentContext: [{
        candidateId: "project-without-task",
        memoryId: "project-without-task",
        fact: "Project memory requires an exact active task.",
        category: "project-memory",
        source: "current-context",
        privacyRisk: "local-private",
        projectTaskId: "task-not-found",
      }],
    });

    expect(result).toMatchObject({ status: "completed", taskId: "unassigned" });
    expect(result.message).toMatch(/Deferred=1|exact.*task|SAFE TO DELETE ORIGINAL CHAT: NO/i);
    await expect(access(join(root, ".d-ai"))).rejects.toThrow();
  });

  it("blocks ambiguous canonical workspace task discovery before any curation write", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-ambiguous-"));
    temporaryRoots.push(root);
    await prepareGitWorkspace(root);
    const durableStore = new FileDurableContextStore(join(root, ".d-ai"));
    await durableStore.createIfAbsent(seededTask(root, "task-curation-a"));
    await durableStore.createIfAbsent(seededTask(root, "task-curation-b"));
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-ambiguous-db-"));
    temporaryRoots.push(databaseRoot);
    const databasePath = join(databaseRoot, "memory.sqlite");
    const activate = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: root, memoryDatabasePath: databasePath }));

    const result = await activate({
      rawCommand: "@D-AI 整理",
      taskId: null,
      currentContext: [{
        candidateId: "ambiguous-fact",
        memoryId: "ambiguous-fact",
        fact: "This fact must not cross ambiguous task ownership.",
        category: "knowledge",
        source: "current-context",
        privacyRisk: "local-private",
      }],
    });

    expect(result).toMatchObject({ status: "blocked", taskId: "unassigned", curationRecords: [] });
    expect(result.message).toMatch(/Multiple active D-AI tasks.*blocked without writes/i);
    expect(result.message).toMatch(/Records=none|SAFE TO DELETE ORIGINAL CHAT: NO.*source chat/i);
    await expect(access(databasePath)).rejects.toThrow();
  });

  it("reuses one OS-local database across two workspaces without adopting either project task", async () => {
    const workspaceA = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-workspace-a-"));
    const workspaceB = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-workspace-b-"));
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-runtime-shared-db-"));
    temporaryRoots.push(workspaceA, workspaceB, databaseRoot);
    await prepareGitWorkspace(workspaceA);
    await prepareGitWorkspace(workspaceB);
    const databasePath = join(databaseRoot, "memory.sqlite");
    const activateA = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: workspaceA, memoryDatabasePath: databasePath }));
    const activateB = createCodexActivation(createConfiguredDAIRuntime({ workspacePath: workspaceB, memoryDatabasePath: databasePath }));

    const resultA = await activateA({
      rawCommand: "@D-AI 整理",
      taskId: null,
      currentContext: [{ candidateId: "workspace-a-fact", memoryId: "workspace-a-fact", fact: "Workspace A selected fact.", category: "knowledge", source: "current-context", privacyRisk: "local-private" }],
    });
    const resultB = await activateB({
      rawCommand: "@D-AI 整理",
      taskId: null,
      currentContext: [{ candidateId: "workspace-b-fact", memoryId: "workspace-b-fact", fact: "Workspace B selected fact.", category: "knowledge", source: "current-context", privacyRisk: "local-private" }],
    });

    expect(resultA).toMatchObject({ status: "completed", taskId: "unassigned" });
    expect(resultB).toMatchObject({ status: "completed", taskId: "unassigned" });
    const reader = new LocalSqliteMemoryStore({ databasePath, workspacePath: dirname(databasePath), mode: "reader", scopeId: resolveLocalMemoryScopeId(databasePath), writerId: "primary-device" });
    try {
      await expect(reader.get("workspace-a-fact")).resolves.not.toBeNull();
      await expect(reader.get("workspace-b-fact")).resolves.not.toBeNull();
    } finally {
      reader.close();
    }
    await expect(access(join(workspaceA, ".d-ai"))).rejects.toThrow();
    await expect(access(join(workspaceB, ".d-ai"))).rejects.toThrow();
  });
});
