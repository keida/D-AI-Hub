import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createKnowledgeQualityLoop } from "../../src/curation/knowledge-quality-loop.js";
import type { CurationCandidate } from "../../src/curation/local-curation.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";

const roots: string[] = [];

async function createWriter(): Promise<{ readonly root: string; readonly store: LocalSqliteMemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-quality-loop-"));
  roots.push(root);
  return {
    root,
    store: new LocalSqliteMemoryStore({
      databasePath: join(root, "memory.sqlite"),
      workspacePath: root,
      mode: "writer",
      scopeId: "quality-loop",
      writerId: "primary-device",
    }),
  };
}

function candidate(overrides: Partial<CurationCandidate> = {}): CurationCandidate {
  return {
    candidateId: "fact-release",
    memoryId: "fact-release",
    fact: "Release checks require a clean worktree.",
    category: "knowledge",
    source: "current-context",
    privacyRisk: "local-private",
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("knowledge quality loop", () => {
  it("recovers a task-scoped snapshot after a fresh store reopen and isolates another task", async () => {
    const { root, store } = await createWriter();
    const databasePath = join(root, "memory.sqlite");
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root, now: () => "2026-09-12T00:00:00.000Z" });
      const result = await loop.curate([candidate({ projectTaskId: "task-a" })], {
        knownProjectTaskId: "task-a",
        taskScopeId: "task-a",
        recordedAt: "2026-09-12T00:00:00.000Z",
      });
      expect(result.safeToDeleteOriginalChat).toBe("YES");
      store.close();

      const reader = new LocalSqliteMemoryStore({ databasePath, workspacePath: root, mode: "reader", scopeId: "quality-loop", writerId: "primary-device" });
      try {
        const reopened = createKnowledgeQualityLoop({ store: reader, workspacePath: root, repositoryPath: root });
        await expect(reopened.recover("task-a")).resolves.toMatchObject({ status: "available", records: [{ memoryId: "fact-release" }] });
        await expect(reopened.recover("task-b")).resolves.toMatchObject({ status: "empty", records: [] });
      } finally {
        reader.close();
      }
    } finally {
      try { store.close(); } catch { /* already closed */ }
    }
  });

  it("reports durable repository assets and stable HTTPS references without storing bytes", async () => {
    const { root, store } = await createWriter();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "fixture.png"), "not image bytes required for reference validation", "utf8");
    await writeFile(join(root, "docs", "evidence.md"), "durable evidence\n", "utf8");
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      const result = await loop.curate([candidate({
        subjectKey: "release-gate",
        observedAt: "2026-09-12T00:00:00.000Z",
        evidenceRefs: ["docs/evidence.md", "https://example.com/release-gate"],
        assetRefs: ["fixture.png"],
      })], { taskScopeId: null, recordedAt: "2026-09-12T00:00:00.000Z" });
      expect(result.qualityReport).toMatchObject({ verdict: "PASS", safeToDeleteOriginalChat: "YES" });
      expect(result.qualityReport?.findings).toEqual([]);
      expect((await store.get("fact-release"))?.value).not.toHaveProperty("bytes");
    } finally {
      store.close();
    }
  });

  it("defers absolute, temporary, and chat-attachment references and never claims safe deletion", async () => {
    const { root, store } = await createWriter();
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      const result = await loop.curate([
        candidate({ memoryId: "absolute-ref", candidateId: "absolute-ref", assetRefs: [join(root, "image.png")] }),
        candidate({ memoryId: "chat-ref", candidateId: "chat-ref", assetRefs: ["chat-attachment.png"] }),
      ], { taskScopeId: null });
      expect(result.safeToDeleteOriginalChat).toBe("NO");
      expect(result.counts.deferred).toBe(2);
      expect(result.qualityReport?.findings.map((finding) => finding.code)).toEqual(["NON_DURABLE_ASSET", "NON_DURABLE_ASSET"]);
      expect(await store.listAll()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("blocks same-batch contradictions, cross-project bindings, invalid supersession, and credential-bearing HTTPS refs", async () => {
    const { root, store } = await createWriter();
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      const result = await loop.curate([
        candidate({ memoryId: "batch-a", candidateId: "batch-a", subjectKey: "same-subject", fact: "First current fact." }),
        candidate({ memoryId: "batch-b", candidateId: "batch-b", subjectKey: "same-subject", fact: "Competing current fact." }),
        candidate({ memoryId: "wrong-task", candidateId: "wrong-task", projectTaskId: "task-b" }),
        candidate({ memoryId: "bad-supersession", candidateId: "bad-supersession", supersedesMemoryIds: ["does-not-exist"] }),
        candidate({ memoryId: "credential-url", candidateId: "credential-url", assetRefs: ["https://user:abc@example.com/fixture.png"] }),
      ], { taskScopeId: "task-a", recordedAt: "2026-09-12T00:00:00.000Z" });
      expect(result.safeToDeleteOriginalChat).toBe("NO");
      expect(result.status).toBe("blocked");
      expect(result.qualityReport?.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
        "BATCH_CONTRADICTION",
        "CROSS_PROJECT_BINDING",
        "INVALID_SUPERSESSION",
        "NON_DURABLE_ASSET",
      ]));
      expect(result.qualityReport?.findings.find((finding) => finding.code === "BATCH_CONTRADICTION")?.detail).toContain("batch supersession is not supported");
      expect(await store.listAll()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("uses one ingestion timestamp for an advancing clock and keeps same-batch conflicts atomic", async () => {
    const { root, store } = await createWriter();
    let calls = 0;
    try {
      const loop = createKnowledgeQualityLoop({
        store,
        workspacePath: root,
        repositoryPath: root,
        now: () => {
          calls += 1;
          return calls === 1 ? "2026-09-12T00:00:00.000Z" : "2026-09-12T00:00:01.000Z";
        },
      });
      const result = await loop.curate([
        candidate({ memoryId: "clock-a", candidateId: "clock-a", subjectKey: "clock-subject", fact: "Clock fact A." }),
        candidate({ memoryId: "clock-b", candidateId: "clock-b", subjectKey: "clock-subject", fact: "Clock fact B." }),
      ], { taskScopeId: null });
      expect(calls).toBe(1);
      expect(result.qualityReport?.findings.some((finding) => finding.code === "BATCH_CONTRADICTION")).toBe(true);
      expect(await store.listAll()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("blocks different same-batch facts even when their freshness differs", async () => {
    const { root, store } = await createWriter();
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      const result = await loop.curate([
        candidate({ memoryId: "ordered-a", candidateId: "ordered-a", subjectKey: "ordered-subject", revision: 1, observedAt: "2026-09-11T00:00:00.000Z", fact: "Older current fact." }),
        candidate({ memoryId: "ordered-b", candidateId: "ordered-b", subjectKey: "ordered-subject", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", fact: "Newer competing fact." }),
      ], { taskScopeId: null, recordedAt: "2026-09-12T00:00:00.000Z" });
      expect(result).toMatchObject({ status: "blocked", safeToDeleteOriginalChat: "NO" });
      expect(result.qualityReport?.findings.some((finding) => finding.code === "BATCH_CONTRADICTION")).toBe(true);
      expect(await store.listAll()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("does not write a duplicate memory ID, while preserving same-memoryId NOOP behavior", async () => {
    const { root, store } = await createWriter();
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      await expect(loop.curate([candidate({ memoryId: "stable-id", candidateId: "stable-id", subjectKey: "stable-subject" })], { taskScopeId: null, recordedAt: "2026-09-12T00:00:00.000Z" })).resolves.toMatchObject({ status: "completed" });
      const duplicate = await loop.curate([candidate({ memoryId: "new-id", candidateId: "new-id", subjectKey: "stable-subject" })], { taskScopeId: null, recordedAt: "2026-09-12T00:00:01.000Z" });
      expect(duplicate).toMatchObject({ status: "completed", safeToDeleteOriginalChat: "NO", counts: { deferred: 1 } });
      expect(duplicate.qualityReport?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "DUPLICATE_SUBJECT_RECORDS", severity: "defer" })]));
      expect(await store.listAll()).toHaveLength(1);
      const sameMemory = await loop.curate([candidate({ memoryId: "stable-id", candidateId: "stable-id", subjectKey: "stable-subject" })], { taskScopeId: null, recordedAt: "2026-09-12T00:00:02.000Z" });
      expect(sameMemory).toMatchObject({ status: "completed", counts: { noOp: 1 }, safeToDeleteOriginalChat: "YES" });
      expect(await store.listAll()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("holds conflicting current facts and allows an explicit newer supersession", async () => {
    const { root, store } = await createWriter();
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      await loop.curate([candidate({ subjectKey: "release", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", projectTaskId: "task-a" })], { taskScopeId: "task-a" });
      const stale = await loop.curate([candidate({
        candidateId: "release-stale",
        memoryId: "release-stale",
        subjectKey: "release",
        revision: 1,
        observedAt: "2026-09-11T00:00:00.000Z",
        fact: "Release checks are stale.",
        projectTaskId: "task-a",
      })], { taskScopeId: "task-a" });
      expect(stale.qualityReport?.findings.some((finding) => finding.code === "STALE_CANDIDATE")).toBe(true);
      expect(stale.safeToDeleteOriginalChat).toBe("NO");
      const newerNoPointer = await loop.curate([candidate({
        candidateId: "release-newer-no-pointer",
        memoryId: "release-newer-no-pointer",
        subjectKey: "release",
        revision: 3,
        observedAt: "2026-09-12T00:02:00.000Z",
        fact: "A newer fact still needs explicit supersession.",
        projectTaskId: "task-a",
      })], { taskScopeId: "task-a" });
      expect(newerNoPointer.qualityReport).toMatchObject({ verdict: "HOLD", safeToDeleteOriginalChat: "NO" });
      expect(newerNoPointer.qualityReport?.findings.some((finding) => finding.code === "CURRENT_COMPETITION")).toBe(true);
      expect(await store.listAll()).toHaveLength(1);
      const olderSupersession = await loop.curate([candidate({
        candidateId: "release-older-supersession",
        memoryId: "release-older-supersession",
        subjectKey: "release",
        revision: 1,
        observedAt: "2026-09-11T00:00:00.000Z",
        fact: "An older fact cannot supersede a newer fact.",
        projectTaskId: "task-a",
        supersedesMemoryIds: ["fact-release"],
      })], { taskScopeId: "task-a" });
      expect(olderSupersession.qualityReport?.findings.some((finding) => finding.code === "STALE_CANDIDATE")).toBe(true);
      expect(olderSupersession.safeToDeleteOriginalChat).toBe("NO");
      const conflict = await loop.curate([candidate({
        candidateId: "release-conflict",
        memoryId: "release-conflict",
        subjectKey: "release",
        revision: 2,
        observedAt: "2026-09-12T00:00:00.000Z",
        fact: "Release checks use an unverified worktree.",
        projectTaskId: "task-a",
      })], { taskScopeId: "task-a" });
      expect(conflict.qualityReport).toMatchObject({ verdict: "HOLD", safeToDeleteOriginalChat: "NO" });
      expect(conflict.qualityReport?.findings.some((finding) => finding.code === "CURRENT_COMPETITION")).toBe(true);

      const superseded = await loop.curate([candidate({
        candidateId: "release-current",
        memoryId: "release-current",
        subjectKey: "release",
        revision: 3,
        observedAt: "2026-09-12T00:01:00.000Z",
        fact: "Release checks require a clean worktree and independent verification.",
        projectTaskId: "task-a",
        supersedesMemoryIds: ["fact-release"],
      })], { taskScopeId: "task-a" });
      expect(superseded.safeToDeleteOriginalChat).toBe("YES");
      await expect(loop.recover("task-a")).resolves.toMatchObject({ records: [{ memoryId: "release-current" }] });
    } finally {
      store.close();
    }
  });

  it("returns NO for a mixed add/defer/reject batch and exposes reviewable improvements", async () => {
    const { root, store } = await createWriter();
    try {
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      const result = await loop.curate([
        candidate({ memoryId: "accepted", candidateId: "accepted" }),
        candidate({ memoryId: "ambiguous", candidateId: "ambiguous", privacyRisk: "possible-workplace" }),
        candidate({ memoryId: "rejected", candidateId: "rejected", privacyRisk: "workplace-confidential" }),
      ], { taskScopeId: null });
      expect(result.counts).toMatchObject({ added: 1, deferred: 1, rejected: 1 });
      expect(result.safeToDeleteOriginalChat).toBe("NO");
      expect(result.qualityReport).toMatchObject({ verdict: "HOLD", improvementCandidates: expect.arrayContaining([
        expect.objectContaining({ code: "ADD_STABLE_SUBJECT_KEY" }),
        expect.objectContaining({ code: "ADD_OBSERVED_AT" }),
      ]) });
    } finally {
      store.close();
    }
  });

  it("reads legacy curated records without treating missing metadata as a cross-project record", async () => {
    const { root, store } = await createWriter();
    try {
      await store.applyMutations([{ operation: "add", memoryId: "legacy-fact", value: {
        kind: "curated-fact",
        fact: "Legacy facts remain readable.",
        category: "knowledge",
        revision: 1,
        projectTaskId: null,
      }, recordedAt: "2026-09-10T00:00:00.000Z" }]);
      const snapshot = await createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root }).recover("task-a");
      expect(snapshot).toMatchObject({ status: "available", records: [{ memoryId: "legacy-fact", subjectKey: "legacy-fact", observedAt: null }] });
    } finally {
      store.close();
    }
  });

  it("detects equal-revision contradictory existing records without using memory ID as freshness", async () => {
    const { root, store } = await createWriter();
    try {
      await store.applyMutations([
        { operation: "add", memoryId: "equal-a", value: { kind: "curated-fact", fact: "Fact A", category: "knowledge", subjectKey: "equal-subject", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-12T00:00:00.000Z" },
        { operation: "add", memoryId: "equal-b", value: { kind: "curated-fact", fact: "Fact B", category: "knowledge", subjectKey: "equal-subject", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-12T00:00:01.000Z" },
      ]);
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      await expect(loop.recover(null)).resolves.toMatchObject({ status: "blocked", records: [], findings: [expect.objectContaining({ code: "CONTRADICTORY_CURRENT_FACTS" })] });
      const result = await loop.curate([candidate({ subjectKey: "equal-subject", memoryId: "equal-new", candidateId: "equal-new" })], { taskScopeId: null, recordedAt: "2026-09-12T00:00:00.000Z" });
      expect(result.qualityReport?.findings.some((finding) => finding.code === "CONTRADICTORY_CURRENT_FACTS")).toBe(true);
      expect(result.safeToDeleteOriginalChat).toBe("NO");
    } finally {
      store.close();
    }
  });

  it("blocks differing-freshness stored conflicts before curation and accepts only a valid superseding latest fact", async () => {
    const { root, store } = await createWriter();
    try {
      await store.applyMutations([
        { operation: "add", memoryId: "legacy-a", value: { kind: "curated-fact", fact: "Legacy fact A", category: "knowledge", subjectKey: "legacy-subject", revision: 1, observedAt: "2026-09-10T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-10T00:00:00.000Z" },
        { operation: "add", memoryId: "legacy-b", value: { kind: "curated-fact", fact: "Legacy fact B", category: "knowledge", subjectKey: "legacy-subject", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-12T00:00:00.000Z" },
      ]);
      const loop = createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root });
      await expect(loop.recover(null)).resolves.toMatchObject({ status: "blocked", records: [], findings: [expect.objectContaining({ code: "CONTRADICTORY_CURRENT_FACTS" })] });
      const attempted = await loop.curate([candidate({ memoryId: "blocked-write", candidateId: "blocked-write", subjectKey: "legacy-subject", fact: "A third fact" })], { taskScopeId: null, recordedAt: "2026-09-12T00:00:01.000Z" });
      expect(attempted).toMatchObject({ status: "blocked", safeToDeleteOriginalChat: "NO" });
      expect(attempted.qualityReport?.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CONTRADICTORY_CURRENT_FACTS" })]));
      expect(await store.listAll()).toHaveLength(2);

      const supersession = await createWriter();
      try {
        await supersession.store.applyMutations([
          { operation: "add", memoryId: "superseded-old", value: { kind: "curated-fact", fact: "Old fact", category: "knowledge", subjectKey: "supersession-subject", revision: 1, observedAt: "2026-09-10T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-10T00:00:00.000Z" },
          { operation: "add", memoryId: "superseding-new", value: { kind: "curated-fact", fact: "New fact", category: "knowledge", subjectKey: "supersession-subject", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", supersedesMemoryIds: ["superseded-old"], projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-12T00:00:00.000Z" },
        ]);
        const supersessionSnapshot = await createKnowledgeQualityLoop({ store: supersession.store, workspacePath: supersession.root, repositoryPath: supersession.root }).recover(null);
        expect(supersessionSnapshot).toMatchObject({ status: "available", records: [{ memoryId: "superseding-new", fact: "New fact" }] });
      } finally {
        supersession.store.close();
      }
    } finally {
      store.close();
    }
  });

  it("collapses pre-existing equivalent current records deterministically and reports the duplicate", async () => {
    const { root, store } = await createWriter();
    try {
      await store.applyMutations([
        { operation: "add", memoryId: "duplicate-old", value: { kind: "curated-fact", fact: "One current fact", category: "knowledge", subjectKey: "duplicate-subject", revision: 1, observedAt: "2026-09-11T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-11T00:00:00.000Z" },
        { operation: "add", memoryId: "duplicate-new", value: { kind: "curated-fact", fact: "One current fact", category: "knowledge", subjectKey: "duplicate-subject", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-12T00:00:00.000Z" },
      ]);
      const snapshot = await createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root }).recover(null);
      expect(snapshot).toMatchObject({ status: "available", records: [{ memoryId: "duplicate-new" }] });
      expect(snapshot.findings).toEqual([expect.objectContaining({ code: "DUPLICATE_SUBJECT_RECORDS", severity: "info", memoryId: "duplicate-new" })]);
    } finally {
      store.close();
    }
  });

  it("does not let an equal-freshness supersession hide a competing fact by memory ID order", async () => {
    const { root, store } = await createWriter();
    try {
      await store.applyMutations([
        { operation: "add", memoryId: "equal-old", value: { kind: "curated-fact", fact: "Old equal-freshness fact", category: "knowledge", subjectKey: "equal-supersession", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-12T00:00:00.000Z" },
        { operation: "add", memoryId: "equal-newer", value: { kind: "curated-fact", fact: "Competing equal-freshness fact", category: "knowledge", subjectKey: "equal-supersession", revision: 2, observedAt: "2026-09-12T00:00:00.000Z", supersedesMemoryIds: ["equal-old"], projectTaskId: null, taskScopeId: null }, recordedAt: "2026-09-12T00:00:00.000Z" },
      ]);
      const snapshot = await createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root }).recover(null);
      expect(snapshot).toMatchObject({ status: "blocked", records: [], findings: [expect.objectContaining({ code: "CONTRADICTORY_CURRENT_FACTS" })] });
    } finally {
      store.close();
    }
  });

  it("blocks secret-shaped facts before any database is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-quality-secret-"));
    roots.push(root);
    const databasePath = join(root, "missing", "memory.sqlite");
    const store = {
      get: async () => null,
      applyMutations: async () => [],
      listAll: async () => [],
    };
    const result = await createKnowledgeQualityLoop({ store, workspacePath: root, repositoryPath: root }).curate([candidate({ fact: "api_key=do-not-store" })]);
    expect(result).toMatchObject({ status: "blocked", safeToDeleteOriginalChat: "NO" });
    await expect(access(databasePath)).rejects.toThrow();
  });

  it("returns HOLD when fresh recovery cannot prove the selected facts", async () => {
    const { root, store } = await createWriter();
    let reads = 0;
    try {
      const flakyStore = {
        get: (memoryId: string) => store.get(memoryId),
        applyMutations: (mutations: Parameters<LocalSqliteMemoryStore["applyMutations"]>[0]) => store.applyMutations(mutations),
        listAll: async () => {
          reads += 1;
          return reads === 1 ? store.listAll() : [];
        },
      };
      const result = await createKnowledgeQualityLoop({ store: flakyStore, workspacePath: root, repositoryPath: root }).curate([candidate()], { taskScopeId: null });
      expect(result.qualityReport).toMatchObject({ verdict: "HOLD", safeToDeleteOriginalChat: "NO", recoveredCount: 0 });
    } finally {
      store.close();
    }
  });
});
