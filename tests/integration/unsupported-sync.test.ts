import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import type { TaskState } from "../../src/domain/types.js";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { createConfiguredDAIRuntime } from "../../src/runtime/d-ai-runtime.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

async function git(cwd: string | null, arguments_: readonly string[]): Promise<void> {
  await runCommand({ command: "git", arguments: arguments_, cwd });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function snapshotFiles(root: string): Promise<ReadonlyMap<string, string>> {
  const snapshot = new Map<string, string>();
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory.length === 0 ? entry.name : join(relativeDirectory, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else {
        snapshot.set(relativePath, createHash("sha256").update(await readFile(absolutePath)).digest("hex"));
      }
    }
  };
  await visit(root, "");
  return snapshot;
}

async function createRepositoryFixture(prefix: string): Promise<{
  readonly root: string;
  readonly repositoryPath: string;
  readonly durableRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repositoryPath = join(root, "repository");
  const durableRoot = join(root, "durable");
  await mkdir(repositoryPath, { recursive: true });
  await git(null, ["init", "--initial-branch=main", repositoryPath]);
  await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
  await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
  await writeFile(join(repositoryPath, "artifact.txt"), "stable fixture\n", "utf8");
  await git(repositoryPath, ["add", "artifact.txt"]);
  await git(repositoryPath, ["commit", "-m", "sync preflight fixture"]);
  await git(repositoryPath, ["remote", "add", "origin", "https://github.com/acme/codex-quota-float.git"]);
  return { root, repositoryPath, durableRoot };
}

function existingTask(repositoryPath: string): TaskState {
  const identityHash = createHash("sha256").update(repositoryPath, "utf8").digest("hex");
  return {
    taskId: "task-existing-sync-fixture",
    goal: "Existing task for sync preflight",
    constraints: [],
    environment: "codex",
    stage: "bootstrap",
    role: "analyst",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: [
      `identity:workspace:${repositoryPath}:${identityHash}`,
      `identity:repository:${repositoryPath}:${identityHash}`,
      "remote-repository:github.com/acme/codex-quota-float",
    ],
    handoffState: "none",
    verificationEvidence: [],
    recoveryPoint: null,
    approvalState: "not-required",
    criticalUnsavedContext: [],
    durableContext: null,
  };
}

describe("unsupported sync preflight", { timeout: 20_000 }, () => {
  it("blocks an explicit sync before creating any durable task", async () => {
    const fixture = await createRepositoryFixture("d-ai-unsupported-sync-empty-");
    try {
      const before = await snapshotFiles(fixture.durableRoot);
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }));

      const result = await activate({ rawCommand: "@D-AI sync codex-quota-float", taskId: null });

      expect(result).toMatchObject({ taskId: "unassigned", stage: "bootstrap", environment: "codex", status: "blocked" });
      expect(result.message).toMatch(/sync.*unsupported|unsupported.*sync|not supported/i);
      expect(await snapshotFiles(fixture.durableRoot)).toEqual(before);
      expect(await pathExists(fixture.durableRoot)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks bare explicit sync before creating any durable task", async () => {
    const fixture = await createRepositoryFixture("d-ai-unsupported-sync-bare-");
    try {
      const before = await snapshotFiles(fixture.durableRoot);
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }));

      const result = await activate({ rawCommand: "@D-AI sync", taskId: null });

      expect(result).toMatchObject({ taskId: "unassigned", stage: "bootstrap", environment: "codex", status: "blocked" });
      expect(result.message).toMatch(/sync.*unsupported|unsupported.*sync|not supported/i);
      expect(await snapshotFiles(fixture.durableRoot)).toEqual(before);
      expect(await pathExists(fixture.durableRoot)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks punctuation-attached explicit sync before creating any durable task", async () => {
    const fixture = await createRepositoryFixture("d-ai-unsupported-sync-punctuation-");
    try {
      await mkdir(join(fixture.repositoryPath, ".agents", "skills"), { recursive: true });
      const before = await snapshotFiles(fixture.durableRoot);
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }));

      const result = await activate({ rawCommand: "@D-AI sync，然后核实 codex-quota-float", taskId: null });

      expect(result).toMatchObject({ taskId: "unassigned", stage: "bootstrap", environment: "codex", status: "blocked" });
      expect(result.message).toMatch(/sync.*unsupported|unsupported.*sync|not supported/i);
      expect(await snapshotFiles(fixture.durableRoot)).toEqual(before);
      expect(await pathExists(fixture.durableRoot)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not mutate an existing durable task when explicit sync is unsupported", async () => {
    const fixture = await createRepositoryFixture("d-ai-unsupported-sync-existing-");
    try {
      const store = new FileDurableContextStore(fixture.durableRoot);
      await store.createIfAbsent(existingTask(fixture.repositoryPath));
      const before = await snapshotFiles(fixture.durableRoot);
      const beforeActive = await store.discoverActiveTasks(fixture.repositoryPath);
      expect(beforeActive).toHaveLength(1);
      expect(beforeActive.map((task) => task.taskId)).toEqual(["task-existing-sync-fixture"]);
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }));

      const result = await activate({ rawCommand: "@D-AI sync codex-quota-float", taskId: "task-existing-sync-fixture" });

      expect(result).toMatchObject({ taskId: "task-existing-sync-fixture", status: "blocked" });
      expect(await snapshotFiles(fixture.durableRoot)).toEqual(before);
      await expect(store.load("task-existing-sync-fixture")).resolves.toMatchObject({
        taskId: "task-existing-sync-fixture",
        goal: "Existing task for sync preflight",
        stage: "bootstrap",
      });

      const explicitResult = await activate({ rawCommand: "@D-AI sync", taskId: "task-existing-sync-fixture" });

      expect(explicitResult).toMatchObject({ taskId: "task-existing-sync-fixture", stage: "bootstrap", status: "blocked" });
      expect(await snapshotFiles(fixture.durableRoot)).toEqual(before);
      const afterActive = await store.discoverActiveTasks(fixture.repositoryPath);
      expect(afterActive).toHaveLength(beforeActive.length);
      expect(afterActive.map((task) => task.taskId)).toEqual(beforeActive.map((task) => task.taskId));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps natural-language unsupported sync read-only", async () => {
    const fixture = await createRepositoryFixture("d-ai-unsupported-sync-natural-");
    try {
      const before = await snapshotFiles(fixture.durableRoot);
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }));

      const result = await activate({ rawCommand: "sync codex-quota-float", taskId: null });

      expect(result).toMatchObject({ taskId: "unassigned", status: "blocked", userIntent: { intent: "sync", risk: "external-read" } });
      expect(await snapshotFiles(fixture.durableRoot)).toEqual(before);
      expect(await pathExists(fixture.durableRoot)).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
