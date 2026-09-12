import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";
import { curateCurrentContext, type CurationCandidate } from "../../src/curation/local-curation.js";

const temporaryRoots: string[] = [];

async function createStore(): Promise<LocalSqliteMemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-curation-"));
  temporaryRoots.push(root);
  return new LocalSqliteMemoryStore({
    databasePath: join(root, "memory.sqlite"),
    workspacePath: root,
    mode: "writer",
    scopeId: "d-ai-hub",
    writerId: "primary-device",
  });
}

function candidate(overrides: Partial<CurationCandidate> = {}): CurationCandidate {
  return {
    candidateId: "fact-release-gate",
    memoryId: "fact-release-gate",
    fact: "Local release checks require a clean worktree.",
    category: "knowledge",
    source: "current-context",
    privacyRisk: "local-private",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local curation", () => {
  it("adds a useful supplied fact and verifies the committed read-back", async () => {
    const store = await createStore();

    try {
      const result = await curateCurrentContext(store, [candidate()], {
        recordedAt: "2026-09-11T00:00:00.000Z",
      });

      expect(result).toMatchObject({
        status: "completed",
        counts: { added: 1, updated: 0, noOp: 0, deferred: 0, rejected: 0 },
        locallyStored: true,
        readBackVerified: true,
        safeToDeleteOriginalChat: "YES",
      });
      expect(result.records).toMatchObject([{ decision: "ADD", memoryId: "fact-release-gate", category: "knowledge" }]);
      expect(await store.get("fact-release-gate")).toMatchObject({
        memoryId: "fact-release-gate",
        value: {
          fact: "Local release checks require a clean worktree.",
          category: "knowledge",
          source: "current-context",
        },
      });
    } finally {
      store.close();
    }
  });

  it("returns NOOP for an already represented concept without a second record", async () => {
    const store = await createStore();

    try {
      await curateCurrentContext(store, [candidate()], { recordedAt: "2026-09-11T00:00:00.000Z" });
      const result = await curateCurrentContext(store, [candidate()], { recordedAt: "2026-09-11T00:01:00.000Z" });

      expect(result.counts).toEqual({ added: 0, updated: 0, noOp: 1, deferred: 0, rejected: 0 });
      expect(result).toMatchObject({ locallyStored: true, readBackVerified: true, safeToDeleteOriginalChat: "YES" });
      expect(result.records[0]).toMatchObject({ decision: "NOOP", memoryId: "fact-release-gate" });
      expect((await store.listAfter(0))).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("performs a deterministic UPDATE only when the supplied revision improves the fact", async () => {
    const store = await createStore();

    try {
      await curateCurrentContext(store, [candidate({ revision: 1 })], { recordedAt: "2026-09-11T00:00:00.000Z" });
      const result = await curateCurrentContext(store, [candidate({
        revision: 2,
        fact: "Local release checks require a clean worktree and independent verification.",
      })], { recordedAt: "2026-09-11T00:02:00.000Z" });

      expect(result.counts).toEqual({ added: 0, updated: 1, noOp: 0, deferred: 0, rejected: 0 });
      expect(await store.get("fact-release-gate")).toMatchObject({
        sequence: 2,
        value: { revision: 2, fact: "Local release checks require a clean worktree and independent verification." },
      });
    } finally {
      store.close();
    }
  });

  it("defers an UPDATE that would rebind a memory to a different project task", async () => {
    const store = await createStore();

    try {
      await curateCurrentContext(store, [candidate({
        category: "project-memory",
        projectTaskId: "task-a",
        revision: 1,
      })], { knownProjectTaskId: "task-a", recordedAt: "2026-09-11T00:02:30.000Z" });
      const result = await curateCurrentContext(store, [candidate({
        category: "project-memory",
        projectTaskId: "task-b",
        revision: 2,
        fact: "A newer fact must not cross task boundaries.",
      })], { knownProjectTaskId: "task-b", recordedAt: "2026-09-11T00:02:31.000Z" });

      expect(result.counts).toEqual({ added: 0, updated: 0, noOp: 0, deferred: 1, rejected: 0 });
      expect(await store.get("fact-release-gate")).toMatchObject({
        value: { projectTaskId: "task-a", revision: 1 },
      });
    } finally {
      store.close();
    }
  });

  it("classifies mixed candidates and keeps workplace-risk candidates out of SQLite", async () => {
    const store = await createStore();

    try {
      const result = await curateCurrentContext(store, [
        candidate({ candidateId: "knowledge-1", memoryId: "knowledge-1" }),
        candidate({ candidateId: "project-1", memoryId: "project-1", category: "project-memory", projectTaskId: "task-937dc8b8c2a683764bc3eb62" }),
        candidate({ candidateId: "cross-1", memoryId: "cross-1", category: "cross-project-memory" }),
        candidate({ candidateId: "workplace-1", memoryId: "workplace-1", privacyRisk: "workplace-confidential" }),
      ], {
        knownProjectTaskId: "task-937dc8b8c2a683764bc3eb62",
        recordedAt: "2026-09-11T00:03:00.000Z",
      });

      expect(result.counts).toEqual({ added: 3, updated: 0, noOp: 0, deferred: 0, rejected: 1 });
      expect(await store.get("knowledge-1")).not.toBeNull();
      expect(await store.get("project-1")).not.toBeNull();
      expect(await store.get("cross-1")).not.toBeNull();
      expect(await store.get("workplace-1")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("defers when no current context is supplied and never claims transcript capture", async () => {
    const store = await createStore();

    try {
      const result = await curateCurrentContext(store, []);

      expect(result).toMatchObject({
        status: "blocked",
        counts: { added: 0, updated: 0, noOp: 0, deferred: 1, rejected: 0 },
        readBackVerified: false,
        safeToDeleteOriginalChat: "NO",
      });
      expect(result.message).toMatch(/current-context candidates|required|not captured/i);
      expect(await store.listAfter(0)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("keeps read-back and SAFE NO false for a rejected-only batch", async () => {
    const store = await createStore();

    try {
      const result = await curateCurrentContext(store, [candidate({ privacyRisk: "workplace-confidential" })]);

      expect(result).toMatchObject({
        status: "completed",
        counts: { added: 0, updated: 0, noOp: 0, deferred: 0, rejected: 1 },
        locallyStored: false,
        readBackVerified: false,
        safeToDeleteOriginalChat: "NO",
      });
    } finally {
      store.close();
    }
  });

  it("defers possible-workplace facts without writing them", async () => {
    const store = await createStore();

    try {
      const result = await curateCurrentContext(store, [candidate({ privacyRisk: "possible-workplace" })]);

      expect(result).toMatchObject({
        status: "completed",
        counts: { added: 0, updated: 0, noOp: 0, deferred: 1, rejected: 0 },
        locallyStored: false,
        readBackVerified: false,
        safeToDeleteOriginalChat: "NO",
      });
      expect(await store.get("fact-release-gate")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("rolls back the whole SQLite transaction when one mutation fails", async () => {
    const store = await createStore();

    try {
      await expect(store.applyMutations([
        { operation: "add", memoryId: "atomic-1", value: { fact: "first" }, recordedAt: "2026-09-11T00:04:00.000Z" },
        { operation: "add", memoryId: "atomic-1", value: { fact: "duplicate" }, recordedAt: "2026-09-11T00:04:01.000Z" },
      ])).rejects.toThrow(/duplicate|already exists/i);
      expect(await store.get("atomic-1")).toBeNull();
      expect(await store.listAfter(0)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("rolls back an earlier SQL mutation when a later mutation fails", async () => {
    const store = await createStore();

    try {
      await expect(store.applyMutations([
        { operation: "add", memoryId: "atomic-first", value: { fact: "first" }, recordedAt: "2026-09-11T00:04:00.000Z" },
        { operation: "update", memoryId: "atomic-missing", value: { fact: "later" }, recordedAt: "2026-09-11T00:04:01.000Z" },
      ])).rejects.toThrow(/does not exist/i);
      expect(await store.get("atomic-first")).toBeNull();
      expect(await store.listAfter(0)).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("returns SAFE TO DELETE: NO when the curation transaction/read-back fails", async () => {
    const store = await createStore();

    try {
      const failingStore = {
        get: (memoryId: string) => store.get(memoryId),
        applyMutations: async (): Promise<never> => {
          throw new Error("synthetic read-back failure");
        },
      };
      const result = await curateCurrentContext(failingStore, [candidate()], { recordedAt: "2026-09-11T00:05:00.000Z" });

      expect(result).toMatchObject({ status: "blocked", locallyStored: false, readBackVerified: false, safeToDeleteOriginalChat: "NO" });
      expect(result.message).toMatch(/transaction\/read-back|safe deletion/i);
      expect(await store.get("fact-release-gate")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("reports committed storage but SAFE NO when post-commit read-back fails", async () => {
    const store = await createStore();
    let readCount = 0;

    try {
      const postCommitReadBackFailure = {
        get: async (memoryId: string) => {
          readCount += 1;
          if (readCount > 1) throw new Error("synthetic post-commit read-back failure");
          return store.get(memoryId);
        },
        applyMutations: (mutations: Parameters<LocalSqliteMemoryStore["applyMutations"]>[0]) => store.applyMutations(mutations),
      };
      const result = await curateCurrentContext(postCommitReadBackFailure, [candidate()], { recordedAt: "2026-09-11T00:06:00.000Z" });

      expect(result).toMatchObject({ status: "blocked", locallyStored: true, readBackVerified: false, safeToDeleteOriginalChat: "NO" });
      expect(result.message).toMatch(/committed.*post-commit read-back|safe deletion/i);
      expect(await store.get("fact-release-gate")).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
