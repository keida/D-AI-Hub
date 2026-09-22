import { describe, expect, it } from "vitest";
import { deriveBossRecovery } from "../../src/runtime/boss-session-recovery.js";
import type { TaskState } from "../../src/domain/types.js";
import type { CurationPipelineRebuild } from "../../src/curation/current-view-pipeline.js";
import type { MemoryRecord } from "../../src/memory/types.js";

const taskId = "task-p4r-boundary";

function fixture(facts: readonly string[]): { state: TaskState; rebuilt: CurationPipelineRebuild } {
  const records: MemoryRecord[] = facts.map((fact, index) => ({
    memoryId: `p4r-limitation-${index}`,
    scopeId: "p4r-scope",
    writerId: "primary-device",
    sequence: index + 1,
    valueSha256: "0".repeat(64),
    recordedAt: "2026-09-23T00:00:00.000Z",
    value: { kind: "curated-fact", fact, category: "project-memory", topicLabel: "workflow/process", critical: true, projectTaskId: taskId, taskScopeId: taskId, subjectKey: `p4r:${index}`, revision: 1, observedAt: "2026-09-23T00:00:00.000Z", supersedesMemoryIds: [], evidenceRefs: [], assetRefs: [] },
  }));
  const state = { taskId, stage: "route", approvalState: "none", handoffState: "none", criticalUnsavedContext: [] } as unknown as TaskState;
  const rebuilt: CurationPipelineRebuild = {
    status: "available", projectTaskId: taskId, checkpoint: null, viewFresh: true, records, sourceCoverage: "unknown", safeToDeleteSourceChat: "NO",
    currentView: { identity: taskId, phase: "route", milestones: [], currentWork: [], confirmedDecisions: [], blockers: [], limitations: facts.map((fact) => fact.slice(0, 256)), nextAction: "resume canonical work.", verificationStatus: "verified", relevantMemoryIds: records.map((record) => record.memoryId), checkpointReference: null },
  };
  return { state, rebuilt };
}

function startup(facts: readonly string[]) {
  const { state, rebuilt } = fixture(facts);
  return deriveBossRecovery("local-project:p4r", state, rebuilt, "startup");
}

describe("P4R bounded limitations presentation", () => {
  it("preserves ordinary under-budget limitations", () => {
    const result = startup(["Constraint one.", "Constraint two."]);
    expect(result.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(result.context?.limitations).toEqual(["Constraint one.", "Constraint two."]);
    expect(result.context?.limitationsPresentation).toMatchObject({ totalCount: 2, inlineCount: 2, omittedCount: 0, truncatedCount: 0, inlineComplete: true });
  });

  it("accepts an exact 2048-byte JSON group and marks limit plus one overflow", () => {
    const exact = [...Array(7).fill("A".repeat(253)), "B".repeat(252)];
    expect(Buffer.byteLength(JSON.stringify(exact), "utf8")).toBe(2048);
    const atLimit = startup(exact);
    expect(atLimit.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(atLimit.context?.limitations).toEqual(exact);
    expect(atLimit.context?.limitationsPresentation.omittedCount).toBe(0);
    const over = startup([...exact.slice(0, -1), "B".repeat(253)]);
    expect(over.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(over.context?.limitationsPresentation).toMatchObject({ totalCount: 8, inlineCount: 7, omittedCount: 1, omittedMemoryIds: ["p4r-limitation-7"], inlineComplete: false });
    expect(Buffer.byteLength(JSON.stringify(over.context?.limitations), "utf8")).toBeLessThanOrEqual(2048);
    expect(over.context?.recovery.taskId).toBe(taskId);
  });

  it("keeps one oversized authoritative fact recoverable while showing only its complete projection item", () => {
    const fact = "X".repeat(3000);
    const { state, rebuilt } = fixture([fact]);
    const result = deriveBossRecovery("local-project:p4r", state, rebuilt, "startup");
    expect(result.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(result.context?.limitations).toEqual([fact.slice(0, 256)]);
    expect(result.context?.limitationsPresentation).toMatchObject({ omittedCount: 0, truncatedCount: 1, truncatedMemoryIds: ["p4r-limitation-0"], inlineComplete: false });
    expect(rebuilt.records[0]?.value).toMatchObject({ fact });
  });

  it("bounds multiple items by UTF-8 bytes without cutting Unicode items", () => {
    const facts = Array.from({ length: 10 }, (_, index) => `${index}界`.repeat(100));
    const result = startup(facts);
    expect(result.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(result.context?.limitationsPresentation.omittedCount).toBeGreaterThan(0);
    expect(result.context?.limitations.every((item) => facts.includes(item))).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.context?.limitations), "utf8")).toBeLessThanOrEqual(2048);
    expect(result.context?.recovery.taskId).toBe(taskId);
  });

  it("omits a projected item sliced between Unicode surrogate halves with a recovery reference", () => {
    const fact = `${"A".repeat(255)}😀 continuation`;
    const result = startup([fact]);
    expect(result.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(result.context?.limitations).toEqual([]);
    expect(result.context?.limitationsPresentation).toMatchObject({ omittedCount: 1, omittedMemoryIds: ["p4r-limitation-0"], truncatedCount: 1, inlineComplete: false });
    expect(result.context?.recovery.taskId).toBe(taskId);
  });

  it("bounds omission references when more than 16 items are omitted", () => {
    const result = startup(Array.from({ length: 40 }, (_, index) => `Constraint ${index}.`));
    expect(result.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(result.context?.limitationsPresentation).toMatchObject({ totalCount: 40, inlineCount: 16, omittedCount: 24, remainingOmittedReferenceCount: 8, inlineComplete: false });
    expect(result.context?.limitationsPresentation.omittedMemoryIds).toHaveLength(16);
    expect(result.context?.recovery.taskId).toBe(taskId);
  });

  it("reduces inline limitations when the complete Boss context would exceed 8192 bytes", () => {
    const { state, rebuilt } = fixture(Array.from({ length: 8 }, (_, index) => `${index}${"L".repeat(251)}`));
    const populated = { ...rebuilt, currentView: { ...rebuilt.currentView!, milestones: Array.from({ length: 7 }, () => "M".repeat(250)), currentWork: Array.from({ length: 7 }, () => "W".repeat(250)), confirmedDecisions: Array.from({ length: 7 }, () => "D".repeat(250)), blockers: ["B".repeat(250)] } };
    const result = deriveBossRecovery("local-project:p4r", state, populated, "startup");
    expect(result.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(result.context?.limitationsPresentation.omittedCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result.context), "utf8")).toBeLessThanOrEqual(8192);
  });

  it("normalizes only harmless projected trailing spaces and leaves authoritative facts unchanged", () => {
    const fact = `${"L".repeat(255)} continuation`;
    const { state, rebuilt } = fixture([fact]);
    const result = deriveBossRecovery("local-project:p4r", state, rebuilt, "startup");
    expect(result.decision).toBe("CONTINUE_CURRENT_BOSS");
    expect(result.context?.limitations).toEqual(["L".repeat(255)]);
    expect(rebuilt.currentView?.limitations).toEqual([`${"L".repeat(255)} `]);
    expect(rebuilt.records[0]?.value).toMatchObject({ fact });
  });

  it("blocks control characters and a view that cannot be traced to authoritative records", () => {
    expect(startup(["Constraint with\ncontrol character."])).toMatchObject({ decision: "BLOCKED", context: null });
    const { state, rebuilt } = fixture(["Authoritative constraint."]);
    const corrupted = { ...rebuilt, currentView: { ...rebuilt.currentView!, limitations: ["Different constraint."] } };
    expect(deriveBossRecovery("local-project:p4r", state, corrupted, "startup")).toMatchObject({ decision: "BLOCKED", context: null });
    const malformedRefs = { ...rebuilt, currentView: { ...rebuilt.currentView!, relevantMemoryIds: null } } as unknown as CurationPipelineRebuild;
    expect(deriveBossRecovery("local-project:p4r", state, malformedRefs, "startup")).toMatchObject({ decision: "BLOCKED", context: null });
    expect(startup(["Malformed \ud83d"])).toMatchObject({ decision: "BLOCKED", context: null });
  });
});
