import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCurationBoundarySha256, createCurationPipeline, extractCurationCandidates, hashCurationSourceKey, type CurationPipelineInput, type PipelineSourceMessage } from "../../src/curation/current-view-pipeline.js";
import type { CurationCheckpoint } from "../../src/memory/types.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";

const roots: string[] = [];

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function legacyCheckpointDigest(checkpoint: CurationCheckpoint): string {
  const { checkpointSha256: _ignored, currentView: _view, currentViewSha256: _viewHash, earliestTrustedMarker: _marker, earliestTrustedBoundarySha256: _boundary, coverageChainComplete: _chain, ...payload } = checkpoint;
  return digest(canonical(payload));
}
function message(marker: string, text: string, overrides: Partial<PipelineSourceMessage> = {}): PipelineSourceMessage { return { marker, text, observedAt: "2026-09-13T00:00:00.000Z", ...overrides }; }
function input(messages: readonly PipelineSourceMessage[], overrides: Partial<CurationPipelineInput> = {}): CurationPipelineInput {
  const previousCoveredThroughMarker = overrides.previousCoveredThroughMarker ?? null;
  const previousBoundarySha256 = overrides.previousBoundarySha256 ?? null;
  return { sourceType: "conversation", sourceKey: "chat-pipeline-test", projectTaskId: "task-atlas", messages, previousCoveredThroughMarker, previousBoundarySha256, sourceStartAttested: previousCoveredThroughMarker === null, coveredThroughMarker: messages.at(-1)!.marker, boundarySha256: buildCurationBoundarySha256(previousCoveredThroughMarker, previousBoundarySha256, messages), coverageConfidence: "complete", ...overrides };
}
async function fixture(): Promise<{ readonly root: string; readonly databasePath: string; readonly store: LocalSqliteMemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-current-view-pipeline-"));
  const databasePath = join(root, "memory.sqlite");
  roots.push(root);
  return { root, databasePath, store: new LocalSqliteMemoryStore({ databasePath, workspacePath: root, mode: "writer", scopeId: "pipeline-scope", writerId: "pipeline-writer" }) };
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("current-state curation pipeline", () => {
  it.each([
    ["Next action: ship the bounded fix.", "ship the bounded fix."],
    ["next action is ship the bounded fix.", "ship the bounded fix."],
    ["Next step: ship the bounded fix.", "ship the bounded fix."],
    ["next step is ship the bounded fix.", "ship the bounded fix."],
    ["下一步：执行边界修复。", "执行边界修复。"],
    ["下一步是执行边界修复。", "执行边界修复。"],
    ["接下来：执行边界修复。", "执行边界修复。"],
    ["接下来要执行边界修复。", "执行边界修复。"],
  ])("materializes only the explicit next-action remainder and preserves it on fresh recovery: %s", async (fact, expected) => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const result = await pipeline.run(input([message("m-001", fact, { subjectKey: "atlas:next-action" })]));
      expect(result).toMatchObject({ status: "completed", currentView: { nextAction: expected } });
      await expect(pipeline.recover("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "available", viewFresh: true, currentView: { nextAction: expected } });
    } finally { store.close(); }
  });

  it.each([
    ["task-d-ai-hub", "d-ai-hub-finalization-source"],
    ["task-quote-float", "quote-float-finalization-source"],
  ])("finalizes a complete trusted chain for %s without rescanning prior windows", async (projectTaskId, sourceKey) => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "Approved source-start coverage anchor.", { memoryId: "final-anchor", subjectKey: "final:anchor" })], { projectTaskId, sourceKey }));
      const finalInput = input([message("m-002", "Milestone completed; next action: close the source chat after recovery.", { memoryId: "final-tail", subjectKey: "final:tail" })], { projectTaskId, sourceKey, previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256, finalWindow: true, trigger: "source-delete-check" });
      const finalized = await pipeline.run(finalInput);
      expect(finalized).toMatchObject({ status: "completed", safeToDeleteSourceChat: "YES", checkpoint: { coveredThroughMarker: "m-002", currentViewVersion: 2, earliestTrustedMarker: "m-001", coverageChainComplete: true } });
      expect(finalized.checkpoint?.earliestTrustedBoundarySha256).toBe(first.checkpoint?.boundarySha256);
      expect(finalized.checkpoint?.lastCandidateIds).toEqual(["final-tail"]);
      expect(finalized.finalization).toMatchObject({ earliestTrustedAnchor: { marker: "m-001", boundarySha256: first.checkpoint!.boundarySha256 }, latestCheckpoint: { coveredThroughMarker: "m-002", currentViewVersion: 2 }, chainComplete: true, uncuratedTailCount: 0, unresolvedCriticalCount: 0, currentViewFresh: true, freshRecovery: true, safeToDeleteSourceChat: "YES", reason: "Fresh whole-source coverage verified" });
      const noop = await pipeline.run(finalInput);
      expect(noop).toMatchObject({ status: "completed", mode: "noop", safeToDeleteSourceChat: "YES" });
      expect(noop.finalization).toMatchObject({ chainComplete: true, uncuratedTailCount: 0, currentViewFresh: true, freshRecovery: true, safeToDeleteSourceChat: "YES" });
    } finally { store.close(); }
  });

  it("anchors a multi-message first checkpoint at its covered-through boundary", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([
        message("m-001", "Approved first source-start fact.", { memoryId: "multi-anchor-one", subjectKey: "multi:one" }),
        message("m-002", "Approved second source-start fact.", { memoryId: "multi-anchor-two", subjectKey: "multi:two" }),
      ]));
      expect(first).toMatchObject({ status: "completed", checkpoint: { coveredThroughMarker: "m-002", earliestTrustedMarker: "m-002", coverageChainComplete: true } });
      expect(first.checkpoint?.earliestTrustedBoundarySha256).toBe(first.checkpoint?.boundarySha256);
    } finally { store.close(); }
  });

  it("keeps finalization NO when the earliest trusted source boundary is unknown", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const result = await pipeline.run(input([message("m-002", "Milestone completed; next action: finalize only after source start is proved.", { memoryId: "unknown-start" })], { finalWindow: true, trigger: "source-delete-check" }));
      expect(result).toMatchObject({ status: "blocked", safeToDeleteSourceChat: "NO" });
      expect(result.finalization).toMatchObject({ earliestTrustedAnchor: null, chainComplete: false, safeToDeleteSourceChat: "NO", reason: "Curation first numeric marker does not attest source start; no source content was deleted" });
    } finally { store.close(); }
  });

  it("keeps finalization NO on a marker gap without advancing the checkpoint", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "Approved source-start coverage anchor.", { memoryId: "gap-anchor" })]));
      const result = await pipeline.run(input([message("m-003", "Milestone completed; next action: finalize after the missing marker is covered.", { memoryId: "gap-tail" })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256, finalWindow: true, trigger: "source-delete-check" }));
      expect(result).toMatchObject({ status: "blocked", checkpointAdvanced: false, safeToDeleteSourceChat: "NO", checkpoint: { coveredThroughMarker: "m-001" } });
      expect(result.finalization).toMatchObject({ chainComplete: true, uncuratedTailCount: 1, safeToDeleteSourceChat: "NO", reason: "Curation source marker gap detected; no source content was deleted" });
    } finally { store.close(); }
  });

  it("keeps finalization NO for partial coverage", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const result = await pipeline.run(input([message("m-001", "Milestone completed; next action: do not finalize partial coverage.", { memoryId: "partial-final" })], { coverageConfidence: "partial", finalWindow: true, trigger: "source-delete-check" }));
      expect(result).toMatchObject({ status: "completed", mode: "bounded-fallback", safeToDeleteSourceChat: "NO" });
      expect(result.finalization).toMatchObject({ earliestTrustedAnchor: null, chainComplete: false, uncuratedTailCount: 1, safeToDeleteSourceChat: "NO", reason: "Curation coverage is partial; bounded supplied-window handling only" });
    } finally { store.close(); }
  });

  it("keeps finalization NO for critical reject", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const result = await pipeline.run(input([message("m-001", "Confidential employer detail must not be retained.", { memoryId: "critical-final", subjectKey: "critical:final", critical: true })], { finalWindow: true, trigger: "source-delete-check" }));
      expect(result).toMatchObject({ status: "completed", safeToDeleteSourceChat: "NO" });
      expect(result.finalization).toMatchObject({ unresolvedCriticalCount: 1, safeToDeleteSourceChat: "NO", reason: "Unresolved critical curation items remain" });
    } finally { store.close(); }
  });

  it("keeps finalization NO for a same-project critical defer", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "A project fact should remain deferred.", { memoryId: "critical-existing", subjectKey: "critical:defer" })]));
      const result = await pipeline.run(input([message("m-002", "A project fact should remain deferred.", { memoryId: "critical-defer", subjectKey: "critical:defer", critical: true })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256, finalWindow: true, trigger: "source-delete-check" }));
      expect(result).toMatchObject({ status: "completed", safeToDeleteSourceChat: "NO", curation: { counts: { deferred: 1 } } });
      expect(result.finalization).toMatchObject({ unresolvedCriticalCount: 1, safeToDeleteSourceChat: "NO", reason: "Unresolved critical curation items remain" });
    } finally { store.close(); }
  });

  it("carries unresolved critical items into a later clean final tail", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "Confidential employer detail must not be retained.", { memoryId: "persistent-critical", subjectKey: "critical:persistent", critical: true })]));
      expect(first).toMatchObject({ status: "completed", checkpoint: { unresolvedCriticalIds: ["persistent-critical"] } });
      const final = await pipeline.run(input([message("m-002", "Milestone completed; next action: resolve the remaining critical item before deletion.", { memoryId: "clean-final-tail", subjectKey: "final:clean-tail" })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256, finalWindow: true, trigger: "source-delete-check" }));
      expect(final).toMatchObject({ status: "completed", checkpoint: { coveredThroughMarker: "m-002", unresolvedCriticalIds: ["persistent-critical"] }, safeToDeleteSourceChat: "NO" });
      expect(final.finalization).toMatchObject({ unresolvedCriticalCount: 1, safeToDeleteSourceChat: "NO", reason: "Unresolved critical curation items remain" });
    } finally { store.close(); }
  });

  it("requires fresh recovery for finalization NOOP", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "Approved source-start coverage anchor.", { memoryId: "stale-final", subjectKey: "stale:final" })]));
      const finalInput = input([message("m-001", "Approved source-start coverage anchor.", { memoryId: "stale-final", subjectKey: "stale:final" })], { previousCoveredThroughMarker: null, previousBoundarySha256: null, finalWindow: true, trigger: "source-delete-check" });
      await store.applyMutations([{ operation: "update", memoryId: "stale-final", value: { kind: "curated-fact", fact: "Changed after the verified view.", category: "project-memory", subjectKey: "stale:final", projectTaskId: "task-atlas", taskScopeId: "task-atlas", revision: 1, observedAt: "2026-09-13T00:00:00.000Z", supersedesMemoryIds: [], evidenceRefs: [], assetRefs: [] }, recordedAt: "2026-09-13T00:00:01.000Z" }]);
      const result = await pipeline.run(finalInput);
      expect(first.checkpoint).not.toBeNull();
      expect(result).toMatchObject({ status: "completed", mode: "noop", safeToDeleteSourceChat: "NO" });
      expect(result.finalization).toMatchObject({ chainComplete: true, currentViewFresh: false, freshRecovery: false, safeToDeleteSourceChat: "NO", reason: "Current-state view is stale or unverified" });
    } finally { store.close(); }
  });

  it("keeps legacy checkpoint rows unknown after idempotent additive migration", async () => {
    const { root, databasePath, store } = await fixture();
    let activeStore: LocalSqliteMemoryStore | null = store;
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "Approved legacy checkpoint coverage anchor.", { memoryId: "legacy-anchor", subjectKey: "legacy:anchor" })]));
      expect(first.checkpoint).not.toBeNull();
      const legacyHash = legacyCheckpointDigest(first.checkpoint!);
      activeStore.close();
      activeStore = null;
      const legacyDatabase = new DatabaseSync(databasePath);
      try {
        legacyDatabase.prepare("UPDATE curation_checkpoints SET earliest_trusted_marker = NULL, earliest_trusted_boundary_sha256 = NULL, coverage_chain_complete = NULL, checkpoint_sha256 = ? WHERE checkpoint_id = ?").run(legacyHash, first.checkpoint!.checkpointId);
        legacyDatabase.exec("ALTER TABLE curation_checkpoints DROP COLUMN earliest_trusted_marker");
        legacyDatabase.exec("ALTER TABLE curation_checkpoints DROP COLUMN earliest_trusted_boundary_sha256");
        legacyDatabase.exec("ALTER TABLE curation_checkpoints DROP COLUMN coverage_chain_complete");
      } finally { legacyDatabase.close(); }
      const migratedStore = new LocalSqliteMemoryStore({ databasePath, workspacePath: root, mode: "writer", scopeId: "pipeline-scope", writerId: "pipeline-writer" });
      activeStore = migratedStore;
      const migratedPipeline = createCurationPipeline({ store: migratedStore, workspacePath: root });
      const recovered = await migratedPipeline.recover("task-atlas", "conversation", "chat-pipeline-test");
      expect(recovered).toMatchObject({ status: "available", viewFresh: true, checkpoint: { earliestTrustedMarker: null, earliestTrustedBoundarySha256: null, coverageChainComplete: null } });
      const final = await migratedPipeline.run(input([message("m-001", "Approved legacy checkpoint coverage anchor.", { memoryId: "legacy-anchor", subjectKey: "legacy:anchor" })], { finalWindow: true, trigger: "source-delete-check" }));
      expect(final).toMatchObject({ status: "completed", mode: "noop", safeToDeleteSourceChat: "NO" });
      expect(final.finalization).toMatchObject({ earliestTrustedAnchor: null, chainComplete: false, safeToDeleteSourceChat: "NO", reason: "Earliest trusted source boundary is unknown" });
      const schema = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect((schema.prepare("PRAGMA table_info(curation_checkpoints)").all() as Array<{ readonly name: string }>).map(({ name }) => name).slice(-3)).toEqual(["earliest_trusted_marker", "earliest_trusted_boundary_sha256", "coverage_chain_complete"]);
      } finally { schema.close(); }
    } finally { activeStore?.close(); }
  });

  it("keeps finalization NO when fresh recovery cannot resolve a checkpoint reference", async () => {
    const { root, databasePath, store } = await fixture();
    let activeStore: LocalSqliteMemoryStore | null = store;
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "Approved recovery failure coverage anchor.", { memoryId: "recovery-anchor", subjectKey: "recovery:anchor" })]));
      expect(first.checkpoint).not.toBeNull();
      activeStore.close();
      activeStore = null;
      const database = new DatabaseSync(databasePath);
      try { database.prepare("DELETE FROM memory_records WHERE memory_id = ?").run("recovery-anchor"); } finally { database.close(); }
      const reopenedStore = new LocalSqliteMemoryStore({ databasePath, workspacePath: root, mode: "writer", scopeId: "pipeline-scope", writerId: "pipeline-writer" });
      activeStore = reopenedStore;
      const reopenedPipeline = createCurationPipeline({ store: reopenedStore, workspacePath: root });
      const final = await reopenedPipeline.run(input([message("m-001", "Approved recovery failure coverage anchor.", { memoryId: "recovery-anchor", subjectKey: "recovery:anchor" })], { finalWindow: true, trigger: "source-delete-check" }));
      expect(final).toMatchObject({ status: "completed", mode: "noop", safeToDeleteSourceChat: "NO" });
      expect(final.finalization).toMatchObject({ chainComplete: true, currentViewFresh: false, freshRecovery: false, safeToDeleteSourceChat: "NO", reason: "Fresh current-state recovery failed" });
    } finally { activeStore?.close(); }
  });

  it("does not infer nextAction from unrelated prose", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const result = await pipeline.run(input([message("m-001", "The discussion mentions a next action but does not state one.", { memoryId: "unrelated-next-action", subjectKey: "atlas:unrelated-next-action" })]));
      expect(result).toMatchObject({ status: "completed", currentView: { nextAction: null } });
      await expect(pipeline.recover("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "available", viewFresh: true, currentView: { nextAction: null } });
    } finally { store.close(); }
  });

  it("uses the latest deterministic ordered explicit next action", async () => {
    const { root, store } = await fixture();
    try {
      const pipeline = createCurationPipeline({ store, workspacePath: root });
      const first = await pipeline.run(input([message("m-001", "Next action: inspect the source boundary.", { memoryId: "next-action-old", subjectKey: "atlas:next-action-old" })]));
      const second = await pipeline.run(input([message("m-002", "Next action is run the bounded recovery.", { memoryId: "next-action-new", subjectKey: "atlas:next-action-new" })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 }));
      expect(second).toMatchObject({ status: "completed", currentView: { nextAction: "run the bounded recovery." } });
      await expect(pipeline.recover("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "available", viewFresh: true, currentView: { nextAction: "run the bounded recovery." } });
    } finally { store.close(); }
  });

  it("extracts short critical replies and assigns only lightweight topic labels", () => {
    const candidates = extractCurationCandidates([
      message("m-001", "好", { memoryId: "short-approval", subjectKey: "atlas:approval", critical: true }),
      message("m-002", "trace ephemeral sha=ephemeral-001 run=ephemeral-001"),
      message("m-003", "Bug root cause is a bounded checkpoint mismatch.", { memoryId: "bug-1", subjectKey: "atlas:bug" }),
    ], "task-atlas");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ memoryId: "short-approval", fact: "好", critical: true, topicLabel: "workflow/process" });
    expect(candidates[1]).toMatchObject({ topicLabel: "bug/root-cause", projectTaskId: "task-atlas" });
  });

  it("requires source-start attestation and a canonical contiguous boundary chain", async () => {
    const { root, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    await expect(pipeline.run(input([message("m-002", "A first window that skips source start.", { memoryId: "skip-start" })]))).resolves.toMatchObject({ status: "blocked", checkpointRecorded: false });
    await expect(pipeline.run(input([message("m-001", "A contiguous first message.", { memoryId: "internal-gap-a" }), message("m-003", "An internal numeric gap must be rejected.", { memoryId: "internal-gap-b" })]))).resolves.toMatchObject({ status: "blocked", checkpointRecorded: false });
    await expect(pipeline.run(input([message("m-001", "A wrong digest must be rejected.", { memoryId: "wrong-digest" })], { boundarySha256: digest("wrong-boundary") }))).resolves.toMatchObject({ status: "blocked", checkpointRecorded: false });
    const first = await pipeline.run(input([message("m-001", "Approved source-start decision.", { memoryId: "chain-v1", subjectKey: "atlas:chain", critical: true })], { sourceKey: "chat-chain" }));
    expect(first.status).toBe("completed");
    await expect(pipeline.run(input([message("m-003", "A numeric marker gap must be rejected.", { memoryId: "chain-gap" })], { sourceKey: "chat-chain", previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 }))).resolves.toMatchObject({ status: "blocked", checkpointRecorded: false });
    const second = await pipeline.run(input([message("m-002", "Approved second contiguous decision.", { memoryId: "chain-v2", subjectKey: "atlas:chain", supersedesMemoryIds: ["chain-v1"], critical: true })], { sourceKey: "chat-chain", previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 }));
    expect(second, JSON.stringify(second)).toMatchObject({ status: "completed", coverageAdvanced: true, checkpoint: { coveredThroughMarker: "m-002" } });
    await expect(pipeline.run(input([message("m-003", "A source key over the persisted bound.", { memoryId: "oversized-source" })], { sourceKey: "s".repeat(129) }))).resolves.toMatchObject({ status: "blocked", checkpointRecorded: false });
    store.close();
  });

  it("surfaces bounded context before curation and preserves explicit outcome semantics", async () => {
    const { root, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const first = await pipeline.run(input([message("m-001", "Approved initial decision for the bounded workflow.", { memoryId: "outcome-fact", subjectKey: "atlas:outcome", revision: 1 })], { sourceKey: "chat-outcomes" }));
    const updated = await pipeline.run(input([message("m-002", "Approved initial decision for the bounded workflow after verification.", { memoryId: "outcome-fact", subjectKey: "atlas:outcome-v2", revision: 2 })], { sourceKey: "chat-outcomes", previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 }));
    expect(updated.curation).toMatchObject({ counts: { updated: 1 } });
    expect(await store.get("outcome-fact")).toMatchObject({ value: { relatedMemoryIds: ["outcome-fact"] } });
    await expect(store.retrieveRelatedMemories({ memoryId: "outcome-fact", subjectKey: "atlas:outcome-v2", projectTaskId: "task-atlas", category: "project-memory", limit: 8 })).resolves.toHaveLength(1);
    await expect(store.retrieveRelatedMemories({ memoryId: null, subjectKey: "atlas:outcome-v2", projectTaskId: "task-atlas", category: "project-memory", limit: 17 })).rejects.toThrow("between 1 and 16");
    const noop = await pipeline.run(input([message("m-003", "Approved initial decision for the bounded workflow after verification.", { memoryId: "outcome-fact", subjectKey: "atlas:outcome-v2", revision: 2 })], { sourceKey: "chat-outcomes", previousCoveredThroughMarker: updated.checkpoint!.coveredThroughMarker, previousBoundarySha256: updated.checkpoint!.boundarySha256 }));
    expect(noop.curation).toMatchObject({ counts: { noOp: 1 } });
    const deferred = await pipeline.run(input([message("m-004", "A project fact from another task must defer.", { memoryId: "outcome-defer", subjectKey: "atlas:defer", projectTaskId: "task-other" })], { sourceKey: "chat-outcomes", previousCoveredThroughMarker: noop.checkpoint!.coveredThroughMarker, previousBoundarySha256: noop.checkpoint!.boundarySha256 }));
    expect(deferred).toMatchObject({ status: "blocked", safeToDeleteSourceChat: "NO", curation: { counts: { deferred: 1 } } });
    const longPacket = extractCurationCandidates([message("m-005", ["Boss packet: inspect current state.", "Ephemeral trace sha=ephemeral-boss-123 run=run-123.", "Worker packet: retry details are transient.", "Durable decision: retain the verified bounded local workflow.", "Worker response: preserve only the durable decision."].join("\n"), { memoryId: "long-packet", subjectKey: "atlas:packet" })], "task-atlas");
    expect(longPacket).toHaveLength(1);
    expect(longPacket[0]?.fact).toContain("Durable decision");
    store.close();
  });

  it("creates an additive checkpoint, preserves supersession, and treats a repeat window as NOOP", async () => {
    const { root, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const first = await pipeline.run(input([message("m-001", "Approved architecture decision for the bounded local workflow.", { memoryId: "decision-v1", subjectKey: "atlas:architecture", critical: true })]));
    expect(first).toMatchObject({ status: "completed", mode: "incremental", checkpointAdvanced: true, safeToDeleteSuppliedContent: "YES", safeToDeleteSourceChat: "NO", checkpoint: { coveredThroughMarker: "m-001", coverageConfidence: "complete", currentViewVersion: 1 } });
    expect(first.currentView?.confirmedDecisions).toContain("Approved architecture decision for the bounded local workflow.");
    const secondInput = input([message("m-002", "Approved architecture decision revised after verification.", { memoryId: "decision-v2", subjectKey: "atlas:architecture", revision: 2, supersedesMemoryIds: ["decision-v1"], critical: true })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 });
    const second = await pipeline.run(secondInput);
    expect(second).toMatchObject({ status: "completed", checkpointAdvanced: true, checkpoint: { coveredThroughMarker: "m-002", unresolvedCriticalIds: [], currentView: { verificationStatus: "verified" } } });
    expect(second.relatedMemoryIds).toEqual(expect.arrayContaining(["decision-v1"]));
    expect(second.relatedMemoryIds).not.toContain("decision-v2");
    expect(second.relatedMemoryIds.length).toBeLessThanOrEqual(32);
    const recovered = await pipeline.recover("task-atlas", "conversation", "chat-pipeline-test");
    expect(recovered).toMatchObject({ status: "available", viewFresh: true, currentView: { currentWork: [] } });
    expect(recovered.records.map(({ memoryId }) => memoryId)).toEqual(["decision-v2"]);
    const beforeReplay = await readFile(join(root, "memory.sqlite"));
    const repeat = await pipeline.run(secondInput);
    expect(repeat).toMatchObject({ status: "completed", mode: "noop", checkpointAdvanced: false, safeToDeleteSuppliedContent: "YES" });
    expect(await readFile(join(root, "memory.sqlite"))).toEqual(beforeReplay);
    const changedReplay = await pipeline.run(input([message("m-002", "Changed content at an already verified marker.", { memoryId: "decision-v2-changed", subjectKey: "atlas:architecture", revision: 2, critical: true })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 }));
    expect(changedReplay).toMatchObject({ status: "blocked", checkpointAdvanced: false, checkpointRecorded: false, safeToDeleteSourceChat: "NO" });
    expect(await readFile(join(root, "memory.sqlite"))).toEqual(beforeReplay);
    const final = await pipeline.run(input([message("m-003", "整理完成; milestone is verified.", { memoryId: "milestone-1", subjectKey: "atlas:milestone" })], { previousCoveredThroughMarker: second.checkpoint!.coveredThroughMarker, previousBoundarySha256: second.checkpoint!.boundarySha256, finalWindow: true, trigger: "source-delete-check" }));
    expect(final).toMatchObject({ status: "completed", checkpointAdvanced: true, safeToDeleteSourceChat: "YES", consolidated: true });
    const table = new DatabaseSync(join(root, "memory.sqlite"), { readOnly: true });
    try {
      expect(table.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'curation_checkpoints'").get()).toBeDefined();
      expect((table.prepare("PRAGMA table_info(curation_checkpoints)").all() as Array<{ readonly name: string }>).map(({ name }) => name)).toEqual([
        "checkpoint_id", "scope_id", "source_type", "source_key_sha256", "covered_through_marker", "boundary_sha256", "last_curated_at", "last_candidate_ids_json", "unresolved_critical_ids_json", "relevant_memory_ids_json", "project_task_id", "coverage_confidence", "last_committed_memory_sequence", "current_view_version", "new_retained_since_consolidation", "current_view_json", "current_view_sha256", "checkpoint_sha256", "earliest_trusted_marker", "earliest_trusted_boundary_sha256", "coverage_chain_complete",
      ]);
      const persisted = table.prepare("SELECT current_view_sha256, checkpoint_sha256 FROM curation_checkpoints WHERE checkpoint_id = ?").get(final.checkpoint!.checkpointId) as { readonly current_view_sha256: string; readonly checkpoint_sha256: string };
      expect(persisted.current_view_sha256).toBe(final.checkpoint!.currentViewSha256);
      expect(persisted.checkpoint_sha256).toBe(final.checkpoint!.checkpointSha256);
    } finally { table.close(); store.close(); }
  });

  it("keeps unscoped knowledge outside project view recovery references", async () => {
    const { root, store } = await fixture();
    await store.applyMutations([{ operation: "add", memoryId: "global-knowledge", value: { kind: "curated-fact", fact: "Reusable global knowledge remains available.", category: "knowledge", subjectKey: "global:knowledge", revision: 1, observedAt: "2026-09-13T00:00:00.000Z", projectTaskId: null, taskScopeId: null, supersedesMemoryIds: [], evidenceRefs: [], assetRefs: [] }, recordedAt: "2026-09-13T00:00:00.000Z" }]);
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const first = await pipeline.run(input([message("m-001", "Approved task-scoped decision remains current.", { memoryId: "task-fact", subjectKey: "atlas:task" })]));
    expect(first.status).toBe("completed");
    expect(first.checkpoint?.relevantMemoryIds).toEqual(first.currentView?.relevantMemoryIds);
    expect(first.checkpoint?.relevantMemoryIds).toEqual(["task-fact"]);
    await expect(pipeline.recover("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "available", viewFresh: true, currentView: { relevantMemoryIds: ["task-fact"] } });
    const refreshed = await pipeline.refreshView("task-atlas", "conversation", "chat-pipeline-test");
    expect(refreshed).toMatchObject({ status: "available", viewFresh: true, currentView: { relevantMemoryIds: ["task-fact"] } });
    expect(refreshed.checkpoint?.relevantMemoryIds).toEqual(refreshed.currentView?.relevantMemoryIds);
    store.close();
  });

  it("keeps source-chat deletion separate and handles partial, boundary, and marker failures with bounded fallback", async () => {
    const { root, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const first = await pipeline.run(input([message("m-001", "Milestone completed; next action: verify the local checkpoint.", { memoryId: "milestone-1", subjectKey: "atlas:milestone" })]));
    const partial = await pipeline.run(input([message("m-002", "Current work remains bounded and local.", { memoryId: "work-1", subjectKey: "atlas:work" })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256, coverageConfidence: "partial" }));
    expect(partial).toMatchObject({ mode: "bounded-fallback", checkpointAdvanced: false, checkpointRecorded: false, coverageAdvanced: false, safeToDeleteSourceChat: "NO", checkpoint: { coveredThroughMarker: "m-001", coverageConfidence: "complete" } });
    const mismatch = await pipeline.run(input([message("m-003", "A boundary mismatch must not advance coverage.", { memoryId: "mismatch-1", subjectKey: "atlas:mismatch" })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256, boundarySha256: digest("wrong-boundary") }));
    expect(mismatch).toMatchObject({ status: "blocked", checkpointAdvanced: false, checkpointRecorded: false, safeToDeleteSourceChat: "NO" });
    const rollback = await pipeline.run(input([message("m-000", "An older marker must not advance coverage.", { memoryId: "rollback-1", subjectKey: "atlas:rollback" })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 }));
    expect(rollback).toMatchObject({ status: "blocked", checkpointAdvanced: false, safeToDeleteSourceChat: "NO" });
    const final = await pipeline.run(input([message("m-002", "整理完成; milestone is verified.", { memoryId: "milestone-2", subjectKey: "atlas:milestone-2" })], { previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256, finalWindow: true, trigger: "source-delete-check" }));
    expect(final).toMatchObject({ status: "completed", mode: "incremental", checkpointAdvanced: true, checkpointRecorded: true, coverageAdvanced: true, safeToDeleteSourceChat: "YES" });
    store.close();
  });

  it("curates a first partial window without fabricating coverage, then accepts a complete source-start window", async () => {
    const { root, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const partial = await pipeline.run(input([message("m-001", "Partial source-start content may be curated conservatively.", { memoryId: "partial-first", subjectKey: "atlas:partial" })], { coverageConfidence: "partial" }));
    expect(partial).toMatchObject({ status: "completed", mode: "bounded-fallback", checkpoint: null, checkpointAdvanced: false, checkpointRecorded: false, coverageAdvanced: false, safeToDeleteSourceChat: "NO" });
    const complete = await pipeline.run(input([message("m-001", "Partial source-start content may be curated conservatively.", { memoryId: "partial-first", subjectKey: "atlas:partial" })]));
    expect(complete).toMatchObject({ status: "completed", mode: "incremental", checkpointAdvanced: true, checkpointRecorded: true, coverageAdvanced: true, checkpoint: { coveredThroughMarker: "m-001", coverageConfidence: "complete" } });
    store.close();
  });

  it("rejects privacy and cross-project candidates without unsafe writes", async () => {
    const { root, databasePath, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const privacy = await pipeline.run(input([message("m-001", "Confidential employer detail must not be retained.", { memoryId: "privacy-1", subjectKey: "atlas:private", critical: true })]));
    expect(privacy).toMatchObject({ status: "completed", safeToDeleteSuppliedContent: "NO", safeToDeleteSourceChat: "NO", curation: { counts: { rejected: 1 } }, checkpoint: { unresolvedCriticalIds: ["privacy-1"] } });
    expect(await store.listAll()).toHaveLength(0);
    const crossProject = await pipeline.run(input([message("m-002", "A project fact from another task must not cross scope.", { memoryId: "cross-project", subjectKey: "other:subject", projectTaskId: "task-beacon" })], { previousCoveredThroughMarker: privacy.checkpoint!.coveredThroughMarker, previousBoundarySha256: privacy.checkpoint!.boundarySha256 }));
    expect(crossProject).toMatchObject({ status: "blocked", checkpointAdvanced: false, safeToDeleteSourceChat: "NO" });
    expect(await store.listAll()).toHaveLength(0);
    expect(hashCurationSourceKey("chat-pipeline-test")).toHaveLength(64);
    await expect(access(databasePath)).resolves.toBeUndefined();
    store.close();
  });

  it("keeps checkpoints for two source conversations independent within one project", async () => {
    const { root, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const first = await pipeline.run(input([message("m-001", "Approved source one decision.", { memoryId: "source-one", subjectKey: "atlas:one" })], { sourceKey: "chat-one" }));
    const second = await pipeline.run(input([message("m-001", "Approved source two decision.", { memoryId: "source-two", subjectKey: "atlas:two" })], { sourceKey: "chat-two" }));
    expect(first.checkpoint?.checkpointId).not.toBe(second.checkpoint?.checkpointId);
    await expect(store.getLatestCurationCheckpoint("conversation", "task-atlas", hashCurationSourceKey("chat-one"))).resolves.toMatchObject({ checkpointId: first.checkpoint!.checkpointId, sourceKeySha256: hashCurationSourceKey("chat-one") });
    await expect(store.getLatestCurationCheckpoint("conversation", "task-atlas", hashCurationSourceKey("chat-two"))).resolves.toMatchObject({ checkpointId: second.checkpoint!.checkpointId, sourceKeySha256: hashCurationSourceKey("chat-two") });
    store.close();
  });

  it("consolidates after 20 newly retained facts and resets the counter without repeating", async () => {
    const { root, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const firstMessages = Array.from({ length: 19 }, (_, index) => message(`m-${String(index + 1).padStart(3, "0")}`, `Decision ${index + 1} is retained in the bounded local workflow.`, { memoryId: `threshold-${index + 1}`, subjectKey: `atlas:threshold-${index + 1}` }));
    const first = await pipeline.run(input(firstMessages, { sourceKey: "chat-threshold" }));
    expect(first).toMatchObject({ status: "completed", consolidated: false, checkpoint: { newRetainedSinceConsolidation: 19 } });
    const second = await pipeline.run(input([message("m-020", "Decision 20 is retained in the bounded local workflow.", { memoryId: "threshold-20", subjectKey: "atlas:threshold-20" })], { sourceKey: "chat-threshold", previousCoveredThroughMarker: first.checkpoint!.coveredThroughMarker, previousBoundarySha256: first.checkpoint!.boundarySha256 }));
    expect(second).toMatchObject({ status: "completed", consolidated: true, checkpoint: { newRetainedSinceConsolidation: 0 } });
    const third = await pipeline.run(input([message("m-021", "Decision 20 is retained in the bounded local workflow.", { memoryId: "threshold-20", subjectKey: "atlas:threshold-20" })], { sourceKey: "chat-threshold", previousCoveredThroughMarker: second.checkpoint!.coveredThroughMarker, previousBoundarySha256: second.checkpoint!.boundarySha256 }));
    expect(third).toMatchObject({ status: "completed", consolidated: false, checkpoint: { newRetainedSinceConsolidation: 0, currentViewVersion: second.checkpoint!.currentViewVersion } });
    store.close();
  });

  it("rolls back memory when the checkpoint atomic unit fails and regenerates a stale view", async () => {
    const { root, databasePath, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const first = await pipeline.run(input([message("m-001", "Approved decision for the pipeline.", { memoryId: "atomic-base", subjectKey: "atlas:atomic" })]));
    expect(first.checkpoint).not.toBeNull();
    const checkpoint = first.checkpoint!;
    expect(checkpoint.currentViewSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(checkpoint.checkpointSha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(store.withCurationCheckpoint(checkpoint, async () => { await store.applyMutations([{ operation: "add", memoryId: "atomic-fail", value: { kind: "curated-fact", fact: "Must roll back.", category: "project-memory", projectTaskId: "task-atlas", taskScopeId: "task-atlas", subjectKey: "atlas:atomic-fail", revision: 1, observedAt: "2026-09-13T00:00:00.000Z", supersedesMemoryIds: [], evidenceRefs: [], assetRefs: [] }, recordedAt: "2026-09-13T00:00:00.000Z" }]); throw new Error("simulated read-back failure"); })).rejects.toThrow("simulated read-back failure");
    expect(await store.get("atomic-fail")).toBeNull();
    await expect(pipeline.refreshView("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "available", viewFresh: true, checkpoint: { currentViewVersion: checkpoint.currentViewVersion } });
    const database = new DatabaseSync(databasePath);
    try { database.prepare("UPDATE curation_checkpoints SET current_view_json = ? WHERE checkpoint_id = ?").run(JSON.stringify({ ...checkpoint.currentView, phase: "tampered" }), checkpoint.checkpointId); } finally { database.close(); }
    await expect(pipeline.recover("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "blocked", viewFresh: false });
    await expect(pipeline.refreshView("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "available", viewFresh: true, checkpoint: { currentViewVersion: checkpoint.currentViewVersion + 1 }, currentView: { phase: "curated" } });
    store.close();
  });

  it("does not re-sign checkpoint metadata corruption during view refresh", async () => {
    const { root, databasePath, store } = await fixture();
    const pipeline = createCurationPipeline({ store, workspacePath: root });
    const first = await pipeline.run(input([message("m-001", "Approved metadata integrity decision.", { memoryId: "metadata-base", subjectKey: "atlas:metadata" })]));
    const database = new DatabaseSync(databasePath);
    try { database.prepare("UPDATE curation_checkpoints SET boundary_sha256 = ? WHERE checkpoint_id = ?").run(digest("corrupt-boundary"), first.checkpoint!.checkpointId); } finally { database.close(); }
    await expect(pipeline.refreshView("task-atlas", "conversation", "chat-pipeline-test")).resolves.toMatchObject({ status: "blocked", viewFresh: false });
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    try { expect((verify.prepare("SELECT boundary_sha256 FROM curation_checkpoints WHERE checkpoint_id = ?").get(first.checkpoint!.checkpointId) as { readonly boundary_sha256: string }).boundary_sha256).toBe(digest("corrupt-boundary")); } finally { verify.close(); store.close(); }
  });
});
