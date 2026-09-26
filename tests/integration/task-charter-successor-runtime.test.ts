import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexCLI } from "../../src/entry/codex-cli.js";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { createConfiguredDAIRuntime } from "../../src/runtime/d-ai-runtime.js";
import type { TaskCharter, TaskState } from "../../src/domain/types.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { taskCharterContentDigest, taskCharterTaskId } from "../../src/state/task-charter.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";
import { resolveLocalMemoryScopeId } from "../../src/memory/local-memory-path.js";
import { runCommand } from "../../src/adapters/command-runner.js";
import { prepareBootstrapTask } from "../../src/bootstrap/bootstrap-task.js";

function charter(projectIdentity: string, objective = "Establish the approved runtime successor", initialPhase?: string): TaskCharter {
  const content = {
    schemaVersion: 1 as const,
    charterId: "runtime-successor-integration",
    charterVersion: "1",
    projectIdentity,
    objective,
    ownedScope: ["one successor task for this existing local project"],
    excludedScope: ["unrelated workspaces and historical task mutation"],
    completionCriteria: ["the successor is durably discoverable after restart"],
    terminationCondition: "Stop after successor routing and recovery checks pass.",
    ...(initialPhase === undefined ? {} : { initialPhase }),
    initialNextAction: "Inspect the existing project and choose one safe next step.",
  };
  const digest = taskCharterContentDigest(content);
  return {
    ...content,
    approval: {
      confirmation: "I_APPROVE_THIS_TASK_CHARTER",
      approvedBy: "integration-test-operator",
      approvedAt: "2026-09-26T00:00:00.000Z",
      approvalReference: "temporary test approval event",
      projectIdentity,
      approvedCharterDigest: digest,
    },
  };
}

describe("approved successor runtime integration", () => {
  it("establishes once through the CLI, converges independent runtimes, and fences later conflict without changing history", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-charter-runtime-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(workspacePath, ".d-ai");
    const memoryDatabasePath = join(root, "memory.sqlite");
    const options = { workspacePath, durableRoot, memoryDatabasePath };
    const store = new FileDurableContextStore(durableRoot);
    try {
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      const memoryStore = new LocalSqliteMemoryStore({ databasePath: memoryDatabasePath, workspacePath: root, mode: "writer", scopeId: resolveLocalMemoryScopeId(memoryDatabasePath), writerId: "primary-device" });
      memoryStore.close();
      const activate = createCodexActivation(createConfiguredDAIRuntime(options));
      const initial = await activate({ rawCommand: "@D-AI establish local successor fixture", taskId: null });
      expect(initial.status, initial.message).toBe("accepted");
      const original = await store.load(initial.taskId);
      if (original === null) throw new Error("Initial local task was not durably created");
      const projectIdentity = original.contextManifest.find((entry) => entry.startsWith("local-project:"));
      if (projectIdentity === undefined) throw new Error("Initial local task has no stable local-project identity");

      const proposed = charter(projectIdentity);
      const charterFile = join(root, "approved-task-charter.json");
      await writeFile(charterFile, JSON.stringify(proposed), "utf8");
      const proposedDigest = taskCharterContentDigest(proposed);
      const ordinaryReuse = await activate({ rawCommand: "@D-AI establish successor", taskId: null, taskCharter: proposed, confirmedTaskCharterDigest: proposedDigest });
      expect(ordinaryReuse).toMatchObject({ taskId: initial.taskId, status: "accepted" });
      expect(ordinaryReuse.taskCharter).toBeUndefined();

      const paused: TaskState = { ...original, routingDisposition: "PAUSED_RESUMABLE" };
      await store.withTaskOwnership(paused.taskId, paused.environment, async (lease) => {
        await store.save({ ...paused, durableContext: null }, lease);
      });
      const pausedReuse = await createCodexActivation(createConfiguredDAIRuntime(options))({
        rawCommand: "@D-AI establish successor", taskId: null, taskCharter: proposed, confirmedTaskCharterDigest: proposedDigest,
      });
      expect(pausedReuse).toMatchObject({ taskId: initial.taskId, status: "accepted" });

      const frozen: TaskState = { ...paused, routingDisposition: "LEGACY_FROZEN", durableContext: null };
      await store.withTaskOwnership(frozen.taskId, frozen.environment, async (lease) => { await store.save(frozen, lease); });
      const frozenBytes = await readFile(join(durableRoot, frozen.taskId, "state.json"));
      const missingCharter = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI establish successor", taskId: null });
      expect(missingCharter).toMatchObject({ taskId: frozen.taskId, status: "blocked" });
      expect(missingCharter.message).toContain("approved task charter");
      expect(await readFile(join(durableRoot, frozen.taskId, "state.json"))).toEqual(frozenBytes);
      const malformedApprovalPath = join(root, "malformed-approval.json");
      const approvalWithoutConfirmation = Object.fromEntries(Object.entries(proposed.approval).filter(([key]) => key !== "confirmation"));
      await writeFile(malformedApprovalPath, JSON.stringify({ ...proposed, approval: approvalWithoutConfirmation }), "utf8");
      const malformedApproval = await runCodexCLI([
        "--workspace", workspacePath,
        "--command", "@D-AI establish successor",
        "--task-charter-file", malformedApprovalPath,
        "--approve-task-charter", proposedDigest,
      ]);
      expect(malformedApproval.exitCode).toBe(2);
      expect(malformedApproval.response.status).toBe("blocked");
      expect(malformedApproval.response.message).toContain("Invalid task charter");
      expect(await readFile(join(durableRoot, frozen.taskId, "state.json"))).toEqual(frozenBytes);

      const successorId = taskCharterTaskId(projectIdentity, taskCharterContentDigest(proposed));
      const concurrent = await Promise.all(Array.from({ length: 12 }, async () => {
        const freshRuntime = createCodexActivation(createConfiguredDAIRuntime(options));
        return freshRuntime({ rawCommand: "@D-AI establish successor", taskId: null, taskCharter: proposed, confirmedTaskCharterDigest: proposedDigest });
      }));
      expect(concurrent.every((result) => result.status === "accepted" && result.taskId === successorId)).toBe(true);
      expect((await store.discoverActiveTasks(workspacePath)).filter((state) => state.routingDisposition !== "LEGACY_FROZEN")).toHaveLength(1);
      const successorBeforeConflict = await store.load(successorId);
      expect(successorBeforeConflict).toMatchObject({
        routingDisposition: "ROUTABLE",
        taskCharter: proposed,
        taskCharterConfirmation: {
          projectIdentity,
          confirmedCharterDigest: proposedDigest,
          channel: "explicit-task-charter-digest",
        },
      });

      const cliResult = await runCodexCLI([
        "--workspace", workspacePath,
        "--command", "@D-AI establish successor",
        "--task-charter-file", charterFile,
        "--approve-task-charter", proposedDigest,
      ]);
      expect(cliResult).toMatchObject({ exitCode: 0, response: { taskId: successorId, status: "accepted", taskCharter: proposed } });
      expect(await store.load(successorId)).toEqual(successorBeforeConflict);
      expect(successorBeforeConflict?.stage).toBe("bootstrap");

      const freshStatus = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI status", taskId: null });
      expect(freshStatus).toMatchObject({ taskId: successorId, status: "accepted", taskCharter: proposed });
      const bossStartup = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI continue", taskId: null });
      expect(bossStartup.taskId).toBe(successorId);
      expect(bossStartup).toMatchObject({
        taskId: successorId,
        taskCharter: { initialNextAction: proposed.initialNextAction },
        bossSession: {
          decision: "BLOCKED",
          phase: null,
          nextAction: null,
          recoveryCompleteness: {
            status: "INCOMPLETE",
            projection: "UNAVAILABLE",
            canonicalNextAction: null,
            missingFields: expect.arrayContaining(["phase", "nextAction"]),
          },
          startup: null,
        },
      });

      const frozenHistory = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI status", taskId: frozen.taskId });
      expect(frozenHistory).toMatchObject({ taskId: frozen.taskId, status: "accepted" });
      expect(frozenHistory.message).toContain("Read-only historical inspection");
      expect(await readFile(join(durableRoot, frozen.taskId, "state.json"))).toEqual(frozenBytes);

      const invalid = { ...proposed, approval: { ...proposed.approval, approvedCharterDigest: "0".repeat(64) } };
      await expect(createCodexActivation(createConfiguredDAIRuntime(options))({
        rawCommand: "@D-AI establish successor", taskId: null, taskCharter: invalid, confirmedTaskCharterDigest: proposedDigest,
      })).rejects.toThrow(/approval does not bind/u);

      const rival = charter(projectIdentity, "A competing objective after publication");
      const conflict = await createCodexActivation(createConfiguredDAIRuntime(options))({
        rawCommand: "@D-AI establish successor", taskId: null, taskCharter: rival, confirmedTaskCharterDigest: taskCharterContentDigest(rival),
      });
      expect(conflict).toMatchObject({ taskId: successorId, status: "blocked" });
      expect(await store.hasProjectSuccessorConflict(projectIdentity)).toBe(true);
      expect(await store.load(successorId)).toEqual(successorBeforeConflict);

      const exactStatus = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI status", taskId: successorId });
      expect(exactStatus).toMatchObject({ taskId: successorId, status: "accepted" });
      const continueByExactCommandId = await createCodexActivation(createConfiguredDAIRuntime(options))({
        rawCommand: `@D-AI continue ${successorId}`, taskId: null,
      });
      expect(continueByExactCommandId).toMatchObject({ taskId: successorId, status: "blocked" });
      const defaultStatusAfterConflict = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI status", taskId: null });
      expect(defaultStatusAfterConflict.status).toBe("blocked");
      const defaultBossAfterConflict = await createCodexActivation(createConfiguredDAIRuntime(options))({ rawCommand: "@D-AI continue", taskId: null });
      expect(defaultBossAfterConflict.status).toBe("blocked");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 120_000);

  it("binds a remote successor to the actual Git root when invoked from a nested workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-charter-nested-root-"));
    const repositoryRoot = join(root, "repository");
    const workspacePath = join(repositoryRoot, "packages", "nested-workspace");
    const durableRoot = join(root, "durable");
    const memoryDatabasePath = join(root, "memory.sqlite");
    const store = new FileDurableContextStore(durableRoot);
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await runCommand({ command: "git", arguments: ["init", "--initial-branch=main", repositoryRoot], cwd: null });
      await writeFile(join(repositoryRoot, "fixture.txt"), "nested successor fixture\n", "utf8");
      await runCommand({ command: "git", arguments: ["config", "user.email", "d-ai@example.test"], cwd: repositoryRoot });
      await runCommand({ command: "git", arguments: ["config", "user.name", "D-AI Test"], cwd: repositoryRoot });
      await runCommand({ command: "git", arguments: ["add", "fixture.txt"], cwd: repositoryRoot });
      await runCommand({ command: "git", arguments: ["commit", "-m", "nested fixture"], cwd: repositoryRoot });
      await runCommand({ command: "git", arguments: ["remote", "add", "origin", "https://github.com/acme/nested-successor.git"], cwd: repositoryRoot });
      const memoryStore = new LocalSqliteMemoryStore({ databasePath: memoryDatabasePath, workspacePath: root, mode: "writer", scopeId: resolveLocalMemoryScopeId(memoryDatabasePath), writerId: "primary-device" });
      memoryStore.close();

      const options = { workspacePath, durableRoot, memoryDatabasePath };
      const original = await prepareBootstrapTask({
        taskId: "task-aaaaaaaaaaaaaaaaaaaaaaaa",
        goal: "Seed nested remote successor fixture",
        environment: "codex",
        workspacePath,
        repositoryPath: repositoryRoot,
      }, store, null);
      const projectIdentity = "remote-repository:github.com/acme/nested-successor";
      const seeded = { ...original, contextManifest: [...original.contextManifest, projectIdentity] };
      await store.createIfAbsent!(seeded);
      const frozen: TaskState = { ...seeded, routingDisposition: "LEGACY_FROZEN", durableContext: null };
      await store.withTaskOwnership(frozen.taskId, frozen.environment, async (lease) => { await store.save(frozen, lease); });

      const proposed = charter(projectIdentity);
      const digest = taskCharterContentDigest(proposed);
      const successor = await createCodexActivation(createConfiguredDAIRuntime(options))({
        rawCommand: "@D-AI establish nested successor",
        taskId: null,
        taskCharter: proposed,
        confirmedTaskCharterDigest: digest,
      });
      expect(successor.status).toBe("accepted");
      const persisted = await store.load(successor.taskId);
      expect(persisted?.contextManifest.some((entry) => entry.startsWith(`identity:workspace:${workspacePath}:`))).toBe(true);
      expect(persisted?.contextManifest.some((entry) => entry.startsWith(`identity:repository:${repositoryRoot}:`))).toBe(true);
      expect(persisted?.contextManifest).toContain(projectIdentity);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 60_000);
});
