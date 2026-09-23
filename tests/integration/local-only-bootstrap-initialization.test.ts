import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createLocalOnlyTaskReservationId } from "../../src/bootstrap/bootstrap-task.js";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { createConfiguredDAIRuntime } from "../../src/runtime/d-ai-runtime.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

const barrier = vi.hoisted(() => ({
  statePath: "",
  prepareEntered: null as (() => void) | null,
  prepareSettled: null as (() => void) | null,
  releasePrepare: null as Promise<void> | null,
  stateCommitEntered: null as (() => void) | null,
  releaseStateCommit: null as Promise<void> | null,
}));

vi.mock("../../src/bootstrap/bootstrap-task.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/bootstrap/bootstrap-task.js")>();
  return {
    ...actual,
    prepareBootstrapTask: async (...args: Parameters<typeof actual.prepareBootstrapTask>) => {
      if (args[0].goal !== "establish second reader" || barrier.releasePrepare === null) return actual.prepareBootstrapTask(...args);
      barrier.prepareEntered?.();
      await barrier.releasePrepare;
      try { return await actual.prepareBootstrapTask(...args); }
      finally { barrier.prepareSettled?.(); }
    },
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === barrier.statePath && barrier.releaseStateCommit !== null) {
        barrier.stateCommitEntered?.();
        await barrier.releaseStateCommit;
      }
      return actual.rename(...args);
    },
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("configured local-only bootstrap during initial publication", () => {
  it("reuses one task when a second bootstrap read sees a valid partial publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p3r-initialization-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    await mkdir(workspacePath, { recursive: true });
    const taskId = await createLocalOnlyTaskReservationId(workspacePath, "codex");
    const taskRoot = join(durableRoot, taskId);
    const prepareEntered = deferred();
    const prepareSettled = deferred();
    const releasePrepare = deferred();
    const stateCommitEntered = deferred();
    const releaseStateCommit = deferred();
    const inspectionEntered = deferred();
    const inspectInitialCreation = FileDurableContextStore.prototype.inspectInitialCreation;
    const inspection = vi.spyOn(FileDurableContextStore.prototype, "inspectInitialCreation")
      .mockImplementation(async function (this: FileDurableContextStore, observedTaskId, environment, workspacePath) {
        inspectionEntered.resolve();
        return inspectInitialCreation.call(this, observedTaskId, environment, workspacePath);
      });
    barrier.statePath = join(taskRoot, "state.json");
    barrier.prepareEntered = prepareEntered.resolve;
    barrier.prepareSettled = prepareSettled.resolve;
    barrier.releasePrepare = releasePrepare.promise;
    barrier.stateCommitEntered = stateCommitEntered.resolve;
    barrier.releaseStateCommit = releaseStateCommit.promise;
    const activate = () => createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }));
    let first: Promise<Awaited<ReturnType<ReturnType<typeof activate>>>> | null = null;
    let second: Promise<Awaited<ReturnType<ReturnType<typeof activate>>>> | null = null;
    try {
      second = activate()({ rawCommand: "@D-AI establish second reader", taskId: null });
      void second.catch(() => {});
      await prepareEntered.promise;
      first = activate()({ rawCommand: "@D-AI establish first writer", taskId: null });
      await stateCommitEntered.promise;
      await expect(access(join(taskRoot, "initializing"))).resolves.toBeUndefined();
      await expect(access(join(taskRoot, "context.json"))).resolves.toBeUndefined();
      await expect(access(join(taskRoot, "state.json"))).rejects.toThrow();
      releasePrepare.resolve();
      await prepareSettled.promise;
      await inspectionEntered.promise;
      await expect(access(join(taskRoot, "state.json"))).rejects.toThrow();
      releaseStateCommit.resolve();
      const [writer, reader] = await Promise.all([first, second]);
      expect(writer).toMatchObject({ status: "accepted", taskId });
      expect(reader).toMatchObject({ status: "accepted", taskId });
      const states = await new FileDurableContextStore(durableRoot).discoverActiveTasks(workspacePath);
      expect(states).toHaveLength(1);
      expect(states[0]?.taskId).toBe(taskId);
      expect(await readdir(join(taskRoot, "active"))).toHaveLength(1);
      await expect(activate()({ rawCommand: "@D-AI establish repeated reader", taskId: null }))
        .resolves.toMatchObject({ status: "accepted", taskId });
    } finally {
      releasePrepare.resolve();
      releaseStateCommit.resolve();
      await Promise.allSettled([first, second].filter((value): value is NonNullable<typeof value> => value !== null));
      barrier.statePath = "";
      barrier.releasePrepare = null;
      barrier.releaseStateCommit = null;
      inspection.mockRestore();
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 20_000);

  it("waits only for a current, owned, matching publication and expires its bounded budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-p3r-guard-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(root, "durable");
    await mkdir(workspacePath, { recursive: true });
    const taskId = await createLocalOnlyTaskReservationId(workspacePath, "codex");
    const taskRoot = join(durableRoot, taskId);
    const stateCommitEntered = deferred();
    const releaseStateCommit = deferred();
    barrier.statePath = join(taskRoot, "state.json");
    barrier.stateCommitEntered = stateCommitEntered.resolve;
    barrier.releaseStateCommit = releaseStateCommit.promise;
    const store = new FileDurableContextStore(durableRoot);
    const writer = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({
      rawCommand: "@D-AI establish guard writer", taskId: null,
    });
    try {
      await stateCommitEntered.promise;
      await expect(store.load(taskId)).rejects.toThrow(/state is missing.*snapshot artifacts remain/);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).resolves.toBe("in-progress");
      const otherWorkspace = join(root, "other-workspace");
      await mkdir(otherWorkspace);
      await expect(store.inspectInitialCreation(taskId, "codex", otherWorkspace)).rejects.toThrow(/workspace identity mismatch/);

      const markerPath = join(taskRoot, "initializing");
      const marker = await readFile(markerPath, "utf8");
      const originalMarkerStat = await stat(markerPath);
      const staleAt = new Date(Date.now() - 31_000);
      await utimes(markerPath, staleAt, staleAt);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/stale/);
      await utimes(markerPath, originalMarkerStat.atime, originalMarkerStat.mtime);

      await rm(markerPath);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/state is missing.*snapshot artifacts remain/);
      await writeFile(markerPath, marker, "utf8");
      await utimes(markerPath, originalMarkerStat.atime, originalMarkerStat.mtime);

      await writeFile(markerPath, "wrong-task\n", "utf8");
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/invalid/);
      await writeFile(markerPath, marker, "utf8");
      await utimes(markerPath, originalMarkerStat.atime, originalMarkerStat.mtime);

      await expect(store.inspectInitialCreation(taskId, "chat", workspacePath)).rejects.toThrow(/environment mismatch/);
      const ownershipGeneration = (await readdir(join(taskRoot, "ownership")))[0]!;
      const ownerPath = join(taskRoot, "ownership", ownershipGeneration, "owner.json");
      const originalOwnerStat = await stat(ownerPath);
      const afterMarker = new Date(originalMarkerStat.mtimeMs + 5_000);
      await utimes(ownerPath, afterMarker, afterMarker);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/predates its owner generation/);
      await utimes(ownerPath, originalOwnerStat.atime, originalOwnerStat.mtime);
      const owner = await readFile(ownerPath, "utf8");
      await writeFile(ownerPath, owner.replace(taskId, "task-wrong-owner"), "utf8");
      await utimes(ownerPath, originalOwnerStat.atime, originalOwnerStat.mtime);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/ownership token mismatch/);
      await writeFile(ownerPath, owner, "utf8");
      await utimes(ownerPath, originalOwnerStat.atime, originalOwnerStat.mtime);
      const leasePath = join(taskRoot, "ownership", ownershipGeneration, "lease");
      const originalLeaseStat = await stat(leasePath);
      await utimes(leasePath, staleAt, staleAt);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/no longer active/);
      await utimes(leasePath, originalLeaseStat.atime, originalLeaseStat.mtime);
      const generationRoot = join(taskRoot, "generations");
      const generationId = (await readdir(generationRoot))[0]!;
      const generationPath = join(generationRoot, generationId);
      const generationStat = await stat(generationPath);
      await utimes(generationPath, staleAt, staleAt);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/predates its marker/);
      await utimes(generationPath, generationStat.atime, generationStat.mtime);
      const generationManifestPath = join(generationRoot, generationId, "manifest.json");
      const generationManifest = await readFile(generationManifestPath, "utf8");
      await writeFile(generationManifestPath, "{}\n", "utf8");
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/generation|manifest/i);
      await writeFile(generationManifestPath, generationManifest, "utf8");
      const contextPath = join(taskRoot, "context.json");
      const context = await readFile(contextPath, "utf8");
      await writeFile(contextPath, "{}\n", "utf8");
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/does not match its generation/);
      await writeFile(contextPath, context, "utf8");

      const reader = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({
        rawCommand: "@D-AI establish timeout reader", taskId: null,
      });
      await expect(reader).resolves.toMatchObject({ status: "blocked", message: expect.stringMatching(/bounded wait.*incomplete/i) });
    } finally {
      releaseStateCommit.resolve();
      await writer;
      barrier.statePath = "";
      barrier.releaseStateCommit = null;
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 20_000);
});
