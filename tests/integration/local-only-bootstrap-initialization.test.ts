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

interface PausedInitialization {
  readonly root: string;
  readonly workspacePath: string;
  readonly taskId: string;
  readonly taskRoot: string;
  readonly durableRoot: string;
  readonly store: FileDurableContextStore;
}

async function withPausedInitialization(run: (fixture: PausedInitialization) => Promise<void>): Promise<void> {
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
  let completed = false;
  try {
    const first = await Promise.race([
      stateCommitEntered.promise.then(() => ({ kind: "state-commit" as const })),
      writer.then(
        () => ({ kind: "writer-completed" as const }),
        (error: unknown) => ({ kind: "writer-failed" as const, error }),
      ),
    ]);
    if (first.kind === "writer-failed") throw first.error;
    if (first.kind === "writer-completed") throw new Error("Initialization writer completed before state commit barrier");
    await expect(store.load(taskId)).rejects.toThrow(/state is missing.*snapshot artifacts remain/);
    await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).resolves.toBe("in-progress");
    await run({ root, workspacePath, taskId, taskRoot, durableRoot, store });
    completed = true;
  } finally {
    releaseStateCommit.resolve();
    const [writerResult] = await Promise.allSettled([writer]);
    barrier.statePath = "";
    barrier.stateCommitEntered = null;
    barrier.releaseStateCommit = null;
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    if (completed) {
      if (writerResult!.status === "rejected") throw writerResult!.reason;
      expect(writerResult!.value).toMatchObject({ status: "accepted", taskId });
    }
  }
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

  it("rejects a different workspace during initial publication", async () => {
    await withPausedInitialization(async ({ root, taskId, store }) => {
      const otherWorkspace = join(root, "other-workspace");
      await mkdir(otherWorkspace);
      await expect(store.inspectInitialCreation(taskId, "codex", otherWorkspace)).rejects.toThrow(/workspace identity mismatch/);
    });
  }, 20_000);

  it("rejects an environment mismatch in a fresh valid initialization", async () => {
    await withPausedInitialization(async ({ taskId, workspacePath, store }) => {
      await expect(store.inspectInitialCreation(taskId, "chat", workspacePath)).rejects.toThrow(/environment mismatch/);
    });
  }, 20_000);

  it("rejects a stale initialization marker", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      const staleAt = new Date(Date.now() - 31_000);
      await utimes(join(taskRoot, "initializing"), staleAt, staleAt);
      const ownershipGeneration = (await readdir(join(taskRoot, "ownership")))[0]!;
      const beforeMarker = new Date(staleAt.getTime() - 5_000);
      await utimes(join(taskRoot, "ownership", ownershipGeneration, "owner.json"), beforeMarker, beforeMarker);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/stale/);
    });
  }, 20_000);

  it("rejects a missing initialization marker beside partial artifacts", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      await rm(join(taskRoot, "initializing"));
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/state is missing.*snapshot artifacts remain/);
    });
  }, 20_000);

  it("rejects a malformed initialization marker", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      await writeFile(join(taskRoot, "initializing"), "wrong-task\n", "utf8");
      const ownershipGeneration = (await readdir(join(taskRoot, "ownership")))[0]!;
      const generationId = (await readdir(join(taskRoot, "generations")))[0]!;
      const now = Date.now();
      const ownerAt = new Date(now - 15_000);
      const markerAt = new Date(now - 10_000);
      const generationAt = new Date(now - 5_000);
      await utimes(join(taskRoot, "ownership", ownershipGeneration, "owner.json"), ownerAt, ownerAt);
      await utimes(join(taskRoot, "initializing"), markerAt, markerAt);
      await utimes(join(taskRoot, "generations", generationId), generationAt, generationAt);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/invalid/);
    });
  }, 20_000);

  it("rejects a marker that predates its owner generation", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      const ownershipGeneration = (await readdir(join(taskRoot, "ownership")))[0]!;
      const ownerPath = join(taskRoot, "ownership", ownershipGeneration, "owner.json");
      const markerStat = await stat(join(taskRoot, "initializing"));
      const afterMarker = new Date(markerStat.mtimeMs + 5_000);
      await utimes(ownerPath, afterMarker, afterMarker);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/predates its owner generation/);
    });
  }, 20_000);

  it("rejects a mismatched ownership token", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      const ownershipGeneration = (await readdir(join(taskRoot, "ownership")))[0]!;
      const ownerPath = join(taskRoot, "ownership", ownershipGeneration, "owner.json");
      const owner = await readFile(ownerPath, "utf8");
      await writeFile(ownerPath, owner.replace(taskId, "task-wrong-owner"), "utf8");
      const markerStat = await stat(join(taskRoot, "initializing"));
      const beforeMarker = new Date(markerStat.mtimeMs - 5_000);
      await utimes(ownerPath, beforeMarker, beforeMarker);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/ownership token mismatch/);
    });
  }, 20_000);

  it("rejects an inactive ownership lease", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      const ownershipGeneration = (await readdir(join(taskRoot, "ownership")))[0]!;
      const staleAt = new Date(Date.now() - 31_000);
      await utimes(join(taskRoot, "ownership", ownershipGeneration, "lease"), staleAt, staleAt);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/no longer active/);
    });
  }, 20_000);

  it("rejects a generation that predates its marker", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      const generationRoot = join(taskRoot, "generations");
      const generationId = (await readdir(generationRoot))[0]!;
      const staleAt = new Date(Date.now() - 31_000);
      await utimes(join(generationRoot, generationId), staleAt, staleAt);
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/predates its marker/);
    });
  }, 20_000);

  it("rejects a corrupt generation manifest", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      const generationRoot = join(taskRoot, "generations");
      const generationId = (await readdir(generationRoot))[0]!;
      await writeFile(join(generationRoot, generationId, "manifest.json"), "{}\n", "utf8");
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/generation|manifest/i);
    });
  }, 20_000);

  it("rejects a corrupt published companion", async () => {
    await withPausedInitialization(async ({ taskId, taskRoot, workspacePath, store }) => {
      await writeFile(join(taskRoot, "context.json"), "{}\n", "utf8");
      await expect(store.inspectInitialCreation(taskId, "codex", workspacePath)).rejects.toThrow(/does not match its generation/);
    });
  }, 20_000);

  it("expires the bounded wait when initialization never completes", async () => {
    await withPausedInitialization(async ({ workspacePath, durableRoot }) => {
      const reader = createCodexActivation(createConfiguredDAIRuntime({ workspacePath, durableRoot }))({
        rawCommand: "@D-AI establish timeout reader", taskId: null,
      });
      await expect(reader).resolves.toMatchObject({ status: "blocked", message: expect.stringMatching(/bounded wait.*incomplete/i) });
    });
  }, 20_000);
});
