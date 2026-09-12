import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { redactSensitiveText } from "../adapters/command-runner.js";
import { containsSecretShapedValue } from "../domain/manifest-id.js";
import type { MemoryRecord } from "../memory/types.js";
import {
  curateCurrentContext,
  validateCurationCandidates,
  type CurationCandidate,
  type CurationOptions,
  type CurationRecordResult,
  type CurationResult,
  type CurationStore,
} from "./local-curation.js";

export type CurationQualitySeverity = "info" | "defer" | "reject" | "blocker";
export type CurationQualityVerdict = "PASS" | "HOLD" | "NO";

export interface CurationQualityFinding {
  readonly code: string;
  readonly severity: CurationQualitySeverity;
  readonly memoryId?: string;
  readonly subjectKey?: string;
  readonly detail: string;
}

export interface CurationImprovementCandidate {
  readonly code: string;
  readonly subjectKey?: string;
  readonly detail: string;
}

export interface CurationQualityReport {
  readonly verdict: CurationQualityVerdict;
  readonly selectedCount: number;
  readonly eligibleCount: number;
  readonly storedCount: number;
  readonly recoveredCount: number;
  readonly findings: readonly CurationQualityFinding[];
  readonly improvementCandidates: readonly CurationImprovementCandidate[];
  readonly safeToDeleteOriginalChat: "YES" | "NO";
}

export interface MemoryRecoveryRecord {
  readonly memoryId: string;
  readonly subjectKey: string;
  readonly category: string;
  readonly revision: number;
  readonly observedAt: string | null;
  readonly fact: string;
  readonly evidenceRefs: readonly string[];
  readonly assetRefs: readonly string[];
}

export interface MemoryRecoverySnapshot {
  readonly status: "available" | "empty" | "blocked";
  readonly taskId: string | null;
  readonly records: readonly MemoryRecoveryRecord[];
  readonly truncated: boolean;
  readonly reason?: string;
  readonly findings?: readonly CurationQualityFinding[];
}

export interface KnowledgeQualityLoopOptions {
  readonly store: CurationStore & { listAll(): Promise<readonly MemoryRecord[]> };
  readonly workspacePath: string;
  readonly repositoryPath?: string | null;
  readonly maxSnapshotRecords?: number;
  readonly now?: () => string;
}

export interface KnowledgeQualityLoop {
  curate(candidates: readonly CurationCandidate[], options?: CurationOptions): Promise<CurationResult>;
  recover(taskId: string | null): Promise<MemoryRecoverySnapshot>;
}

interface StoredFact {
  readonly memoryId: string;
  readonly subjectKey: string;
  readonly fact: string;
  readonly category: string;
  readonly revision: number;
  readonly observedAt: string | null;
  readonly projectTaskId: string | null;
  readonly taskScopeId: string | null;
  readonly supersedesMemoryIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly assetRefs: readonly string[];
}

interface NormalizedCandidate {
  readonly candidate: CurationCandidate;
  readonly subjectKey: string;
  readonly observedAt: string;
  readonly improvementCandidates: readonly CurationImprovementCandidate[];
}

const defaultSnapshotLimit = 32;

function safeText(value: string, limit = 160): string {
  const normalized = redactSensitiveText(value.replace(/[\r\n\t]+/gu, " ").trim());
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : [];
}

function storedFact(record: MemoryRecord): StoredFact | null {
  if (!isRecord(record.value) || record.value.kind !== "curated-fact" || typeof record.value.fact !== "string" || typeof record.value.category !== "string") return null;
  return {
    memoryId: record.memoryId,
    subjectKey: typeof record.value.subjectKey === "string" ? record.value.subjectKey : record.memoryId,
    fact: record.value.fact,
    category: record.value.category,
    revision: typeof record.value.revision === "number" && Number.isSafeInteger(record.value.revision) ? record.value.revision : 1,
    observedAt: typeof record.value.observedAt === "string" ? record.value.observedAt : null,
    projectTaskId: typeof record.value.projectTaskId === "string" ? record.value.projectTaskId : null,
    taskScopeId: typeof record.value.taskScopeId === "string" ? record.value.taskScopeId : null,
    supersedesMemoryIds: stringList(record.value.supersedesMemoryIds),
    evidenceRefs: stringList(record.value.evidenceRefs),
    assetRefs: stringList(record.value.assetRefs),
  };
}

function compareFreshness(left: { readonly revision: number; readonly observedAt: string | null; readonly memoryId: string }, right: { readonly revision: number; readonly observedAt: string | null; readonly memoryId: string }): number {
  const freshness = compareFreshnessOnly(left, right);
  return freshness !== 0 ? freshness : left.memoryId.localeCompare(right.memoryId);
}

function compareFreshnessOnly(left: { readonly revision: number; readonly observedAt: string | null }, right: { readonly revision: number; readonly observedAt: string | null }): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  const leftObserved = left.observedAt ?? "";
  const rightObserved = right.observedAt ?? "";
  return leftObserved.localeCompare(rightObserved);
}

function taskMatches(fact: StoredFact, taskId: string | null): boolean {
  if (fact.taskScopeId !== null) return fact.taskScopeId === taskId && (fact.projectTaskId === null || fact.projectTaskId === taskId);
  if (fact.projectTaskId !== null) return fact.projectTaskId === taskId;
  return fact.category !== "project-memory";
}

function isSecretOrForbiddenReference(reference: string): boolean {
  return containsSecretShapedValue(reference) || /(?:password|secret|token|cookie|credential|auth|private-key)/iu.test(reference);
}

async function validateDurableReference(reference: string, kind: "evidence" | "asset", repositoryPath: string | null): Promise<boolean> {
  if (isSecretOrForbiddenReference(reference)) return false;
  if (/^https:\/\//iu.test(reference)) {
    try {
      const parsed = new URL(reference);
      return parsed.username.length === 0 && parsed.password.length === 0;
    } catch {
      return false;
    }
  }
  if (/^https?:\/\//iu.test(reference) || isAbsolute(reference) || /^[A-Za-z]:[\\/]/u.test(reference) || /^\\\\/u.test(reference)) return false;
  if (repositoryPath === null || reference.startsWith("../") || reference.startsWith("..\\") || reference.includes("\\")) return false;
  const root = resolve(repositoryPath);
  const target = resolve(root, reference);
  const boundary = relative(root, target);
  if (boundary === "" || boundary.startsWith("..") || isAbsolute(boundary)) return false;
  if (kind === "asset" && !/\.(?:png|gif)$/iu.test(reference)) return false;
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

function qualityBlockedResult(message: string, records: readonly CurationRecordResult[], findings: readonly CurationQualityFinding[], selectedCount: number): CurationResult {
  return {
    status: "blocked",
    counts: { added: 0, updated: 0, noOp: 0, deferred: selectedCount > 0 ? selectedCount : 1, rejected: 0 },
    records,
    locallyStored: false,
    readBackVerified: false,
    safeToDeleteOriginalChat: "NO",
    message,
    qualityReport: {
      verdict: "HOLD",
      selectedCount,
      eligibleCount: 0,
      storedCount: 0,
      recoveredCount: 0,
      findings,
      improvementCandidates: [],
      safeToDeleteOriginalChat: "NO",
    },
  };
}

function qualityDeferredResult(message: string, records: readonly CurationRecordResult[], findings: readonly CurationQualityFinding[], selectedCount: number): CurationResult {
  const blocked = qualityBlockedResult(message, records, findings, selectedCount);
  return {
    ...blocked,
    status: "completed",
    counts: { ...blocked.counts, deferred: selectedCount > 0 ? selectedCount : 1 },
    qualityReport: {
      ...blocked.qualityReport!,
      verdict: "NO",
    },
  };
}

function mergeCounts(base: CurationResult["counts"], extra: { readonly deferred: number; readonly rejected: number }): CurationResult["counts"] {
  return { ...base, deferred: base.deferred + extra.deferred, rejected: base.rejected + extra.rejected };
}

function recoveryRecord(record: MemoryRecord, fact: StoredFact): MemoryRecoveryRecord {
  return {
    memoryId: record.memoryId,
    subjectKey: safeText(fact.subjectKey, 128),
    category: safeText(fact.category, 64),
    revision: fact.revision,
    observedAt: fact.observedAt,
    fact: safeText(fact.fact),
    evidenceRefs: fact.evidenceRefs.map((reference) => safeText(reference, 256)),
    assetRefs: fact.assetRefs.map((reference) => safeText(reference, 256)),
  };
}

export function createKnowledgeQualityLoop(options: KnowledgeQualityLoopOptions): KnowledgeQualityLoop {
  const repositoryPath = options.repositoryPath === null ? null : resolve(options.repositoryPath ?? options.workspacePath);
  const maxSnapshotRecords = options.maxSnapshotRecords ?? defaultSnapshotLimit;
  const now = options.now ?? (() => new Date().toISOString());

  async function recover(taskId: string | null): Promise<MemoryRecoverySnapshot> {
    try {
      const records = await options.store.listAll();
      const candidates = records
        .map((record) => ({ record, fact: storedFact(record) }))
        .filter((entry): entry is { readonly record: MemoryRecord; readonly fact: StoredFact } => entry.fact !== null && taskMatches(entry.fact, taskId));
      const superseded = new Set(candidates.flatMap(({ record, fact }) => fact.supersedesMemoryIds.filter((memoryId) => {
        const target = candidates.find((entry) => entry.record.memoryId === memoryId);
        return target !== undefined
          && target.fact.subjectKey === fact.subjectKey
          && taskMatches(target.fact, taskId)
          && compareFreshnessOnly(fact, target.fact) > 0;
      })));
      const visible = candidates.filter(({ record }) => !superseded.has(record.memoryId));
      const duplicateFindings: CurationQualityFinding[] = [];
      const duplicateGroups = new Map<string, readonly { readonly record: MemoryRecord; readonly fact: StoredFact }[]>();
      for (const entry of visible) {
        const duplicateKey = `${entry.fact.subjectKey}\u0000${entry.fact.fact}`;
        duplicateGroups.set(duplicateKey, [...(duplicateGroups.get(duplicateKey) ?? []), entry]);
      }
      const deduplicatedVisible: { readonly record: MemoryRecord; readonly fact: StoredFact }[] = [];
      for (const entries of duplicateGroups.values()) {
        const ordered = [...entries].sort((left, right) => compareFreshness(left.fact, right.fact));
        const selected = ordered.at(-1)!;
        deduplicatedVisible.push(selected);
        if (entries.length > 1) {
          duplicateFindings.push({
            code: "DUPLICATE_SUBJECT_RECORDS",
            severity: "info",
            memoryId: selected.record.memoryId,
            subjectKey: selected.fact.subjectKey,
            detail: "Recovery collapsed equivalent current records to one deterministic representative; duplicate records require review",
          });
        }
      }
      const conflictFindings: CurationQualityFinding[] = [];
      const bySubject = new Map<string, readonly { readonly record: MemoryRecord; readonly fact: StoredFact }[]>();
      for (const entry of deduplicatedVisible) {
        const current = bySubject.get(entry.fact.subjectKey) ?? [];
        bySubject.set(entry.fact.subjectKey, [...current, entry]);
      }
      for (const [subjectKey, entries] of bySubject) {
        for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
          for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
            const left = entries[leftIndex]!;
            const right = entries[rightIndex]!;
            if (left.fact.fact !== right.fact.fact) {
              conflictFindings.push({
                code: "CONTRADICTORY_CURRENT_FACTS",
                severity: "blocker",
                memoryId: right.record.memoryId,
                subjectKey,
                detail: "Recovery found competing current records for one subject",
              });
            }
          }
        }
      }
      if (conflictFindings.length > 0) {
        return {
          status: "blocked",
          taskId,
          records: [],
          truncated: false,
          reason: "Task-scoped memory recovery found unresolved contradictory current facts",
          findings: [...duplicateFindings, ...conflictFindings].slice(0, 8),
        };
      }
      const bounded = deduplicatedVisible.slice(-maxSnapshotRecords);
      return {
        status: bounded.length === 0 ? "empty" : "available",
        taskId,
        records: bounded.map(({ record, fact }) => recoveryRecord(record, fact)),
        truncated: deduplicatedVisible.length > bounded.length,
        ...(duplicateFindings.length > 0 ? { findings: duplicateFindings.slice(0, 8) } : {}),
        ...(bounded.length === 0 ? { reason: "No task-scoped curated facts are available" } : {}),
      };
    } catch (error: unknown) {
      return {
        status: "blocked",
        taskId,
        records: [],
        truncated: false,
        reason: safeText(error instanceof Error ? error.message : String(error)),
      };
    }
  }

  async function curate(candidates: readonly CurationCandidate[], curationOptions: CurationOptions = {}): Promise<CurationResult> {
    const selectedCount = candidates.length;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return qualityBlockedResult("Knowledge quality gate requires selected current-context candidates", [], [{ code: "NO_SELECTED_CANDIDATES", severity: "defer", detail: "No structured candidates were supplied" }], selectedCount);
    }

    let existing: readonly MemoryRecord[];
    try {
      existing = await options.store.listAll();
      validateCurationCandidates(candidates);
    } catch (error: unknown) {
      return qualityBlockedResult(`Knowledge quality preflight failed: ${safeText(error instanceof Error ? error.message : String(error))}`, [], [{ code: "PREFLIGHT_FAILED", severity: "blocker", detail: "Candidate validation or store inspection failed" }], selectedCount);
    }

    const existingFacts = existing.map((record) => ({ record, fact: storedFact(record) })).filter((entry): entry is { readonly record: MemoryRecord; readonly fact: StoredFact } => entry.fact !== null);
    const taskScopeId = curationOptions.taskScopeId ?? curationOptions.knownProjectTaskId ?? null;
    const existingSnapshot = await recover(taskScopeId);
    if (existingSnapshot.status === "blocked") {
      return qualityBlockedResult(
        "Knowledge quality preflight found unresolved task-scoped memory state; no selected fact was persisted",
        [],
        existingSnapshot.findings ?? [{ code: "RECOVERY_BLOCKED", severity: "blocker", detail: "Existing task-scoped memory recovery is blocked" }],
        selectedCount,
      );
    }
    const ingestionObservedAt = curationOptions.recordedAt ?? now();
    const findings: CurationQualityFinding[] = [];
    const improvements: CurationImprovementCandidate[] = [];
    const eligible: CurationCandidate[] = [];
    const batchCandidates: NormalizedCandidate[] = [];
    const rejectedRecords: CurationRecordResult[] = [];
    let deferred = 0;
    let rejected = 0;

    for (const original of candidates) {
      const subjectKey = original.subjectKey ?? original.memoryId;
      const observedAt = original.observedAt ?? ingestionObservedAt;
      const improvementCandidates: CurationImprovementCandidate[] = [];
      if (original.subjectKey === undefined) improvementCandidates.push({ code: "ADD_STABLE_SUBJECT_KEY", subjectKey, detail: "Derive a stable subject key explicitly at the producer boundary" });
      if (original.observedAt === undefined) improvementCandidates.push({ code: "ADD_OBSERVED_AT", subjectKey, detail: "Carry the source observation timestamp instead of relying on ingestion time" });
      improvements.push(...improvementCandidates);
      const normalized: NormalizedCandidate = { candidate: { ...original, subjectKey, observedAt }, subjectKey, observedAt, improvementCandidates };
      let invalidReference = false;
      for (const reference of original.evidenceRefs ?? []) {
        if (!(await validateDurableReference(reference, "evidence", repositoryPath))) {
          invalidReference = true;
          findings.push({ code: "NON_DURABLE_REFERENCE", severity: "defer", memoryId: original.memoryId, subjectKey, detail: "Evidence reference is not a stable HTTPS or repository-relative file" });
        }
      }
      for (const reference of original.assetRefs ?? []) {
        if (!(await validateDurableReference(reference, "asset", repositoryPath))) {
          invalidReference = true;
          findings.push({ code: "NON_DURABLE_ASSET", severity: "defer", memoryId: original.memoryId, subjectKey, detail: "Image/file reference is not a durable repository-relative PNG/GIF or stable HTTPS reference" });
        }
      }
      if (invalidReference) {
        deferred += 1;
        rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
        continue;
      }

      if (original.category === "project-memory" && taskScopeId === null) {
        findings.push({ code: "MISSING_TASK_BINDING", severity: "defer", memoryId: original.memoryId, subjectKey, detail: "Project-memory facts require an exact task scope" });
        deferred += 1;
        rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
        continue;
      }
      if (original.projectTaskId !== undefined && original.projectTaskId !== taskScopeId) {
        findings.push({ code: "CROSS_PROJECT_BINDING", severity: "blocker", memoryId: original.memoryId, subjectKey, detail: "Candidate project task does not match the exact task scope" });
        deferred += 1;
        rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
        continue;
      }
      const invalidSupersession = (original.supersedesMemoryIds ?? []).some((memoryId: string) => {
        const target = existingFacts.find(({ record }) => record.memoryId === memoryId);
        return target === undefined || target.fact.subjectKey !== subjectKey || !taskMatches(target.fact, taskScopeId);
      });
      if (invalidSupersession) {
        findings.push({ code: "INVALID_SUPERSESSION", severity: "blocker", memoryId: original.memoryId, subjectKey, detail: "Every supersession target must exist for the same subject and task scope" });
        deferred += 1;
        rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
        continue;
      }

      const batchRelated = batchCandidates.filter(({ candidate }) => candidate.subjectKey === subjectKey
        && (candidate.projectTaskId ?? null) === (original.projectTaskId ?? null));
      const batchContradiction = batchRelated.find(({ candidate }) => candidate.fact !== original.fact);
      if (batchContradiction !== undefined) {
        findings.push({ code: "BATCH_CONTRADICTION", severity: "blocker", memoryId: original.memoryId, subjectKey, detail: "The selected batch contains different facts for the same subject; batch supersession is not supported" });
        deferred += 1;
        rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
        continue;
      }
      const batchCurrent = [...batchRelated].sort((left, right) => compareFreshness(
        { revision: left.candidate.revision ?? 1, observedAt: left.observedAt, memoryId: left.candidate.memoryId },
        { revision: right.candidate.revision ?? 1, observedAt: right.observedAt, memoryId: right.candidate.memoryId },
      )).at(-1);
      if (batchCurrent !== undefined) {
        const batchFreshness = compareFreshnessOnly(
          { revision: original.revision ?? 1, observedAt },
          { revision: batchCurrent.candidate.revision ?? 1, observedAt: batchCurrent.observedAt },
        );
        if (batchFreshness < 0) {
          findings.push({ code: "BATCH_STALE_CANDIDATE", severity: "defer", memoryId: original.memoryId, subjectKey, detail: "Candidate is older than another selected fact for the same subject" });
          deferred += 1;
          rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
          continue;
        }
        if (batchFreshness === 0) {
          findings.push({
            code: batchCurrent.candidate.fact === original.fact ? "BATCH_DUPLICATE" : "BATCH_CONTRADICTION",
            severity: batchCurrent.candidate.fact === original.fact ? "defer" : "blocker",
            memoryId: original.memoryId,
            subjectKey,
            detail: batchCurrent.candidate.fact === original.fact
              ? "The selected batch contains duplicate current facts"
              : "The selected batch contains competing current facts",
          });
          deferred += 1;
          rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
          continue;
        }
      }

      const related = existingFacts.filter(({ fact }) => fact.subjectKey === subjectKey && taskMatches(fact, taskScopeId));
      const current = [...related].sort((left, right) => compareFreshness(left.fact, right.fact)).at(-1);
      const currentFacts = related.filter(({ fact }) => current !== undefined && compareFreshnessOnly(fact, current.fact) === 0 && fact.fact !== current.fact.fact);
      if (currentFacts.length > 0) {
        findings.push({ code: "CONTRADICTORY_CURRENT_FACTS", severity: "blocker", memoryId: original.memoryId, subjectKey, detail: "Multiple current records for one subject disagree" });
        deferred += 1;
        rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
        continue;
      }
      const duplicateCurrent = related.some(({ record, fact }) => record.memoryId !== original.memoryId && fact.fact === original.fact);
      if (duplicateCurrent) {
        findings.push({ code: "DUPLICATE_SUBJECT_RECORDS", severity: "defer", memoryId: original.memoryId, subjectKey, detail: "An equivalent current fact already exists under another memory ID; no duplicate durable record was created" });
        deferred += 1;
        rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
        continue;
      }
      if (related.length > 0) {
        findings.push({ code: "DUPLICATE_SUBJECT_RECORDS", severity: "info", memoryId: original.memoryId, subjectKey, detail: "Existing records share the same stable subject key" });
      }
      if (current !== undefined && current.fact.fact !== original.fact) {
        const candidateFreshness = compareFreshnessOnly({ revision: original.revision ?? 1, observedAt }, current.fact);
        const explicitlySupersedesCurrent = (original.supersedesMemoryIds ?? []).includes(current.record.memoryId);
        const candidateIsOlder = candidateFreshness < 0;
        if (candidateIsOlder) {
          findings.push({ code: "STALE_CANDIDATE", severity: "defer", memoryId: original.memoryId, subjectKey, detail: "Candidate is older than the current subject record" });
          deferred += 1;
          rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
          continue;
        }
        if (explicitlySupersedesCurrent && candidateFreshness === 0) {
          findings.push({ code: "STALE_CANDIDATE", severity: "defer", memoryId: original.memoryId, subjectKey, detail: "A superseding fact must be newer than the current subject record" });
          deferred += 1;
          rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
          continue;
        }
        if (!explicitlySupersedesCurrent) {
          findings.push({ code: "CURRENT_COMPETITION", severity: "blocker", memoryId: original.memoryId, subjectKey, detail: "Candidate competes with a current record without an explicit supersession pointer" });
          deferred += 1;
          rejectedRecords.push({ decision: "DEFER", memoryId: original.memoryId, category: original.category, summary: safeText(original.fact, 96) });
          continue;
        }
      }
      eligible.push(normalized.candidate);
      batchCandidates.push(normalized);
    }

    if (findings.some((finding) => finding.severity === "blocker")) {
      const heldRecords = [
        ...eligible.map((candidate) => ({ decision: "DEFER" as const, memoryId: candidate.memoryId, category: candidate.category, summary: safeText(candidate.fact, 96) })),
        ...rejectedRecords,
      ];
      return qualityBlockedResult("Knowledge quality gate found an unresolved blocker; no selected fact was persisted", heldRecords, findings, selectedCount);
    }

    if (eligible.length === 0) {
      return findings.some((finding) => finding.severity === "blocker")
        ? qualityBlockedResult("Knowledge quality gate found no eligible selected facts", rejectedRecords, findings, selectedCount)
        : qualityDeferredResult("Knowledge quality gate deferred all selected facts", rejectedRecords, findings, selectedCount);
    }

    const base = await curateCurrentContext(options.store, eligible, { ...curationOptions, taskScopeId: curationOptions.taskScopeId ?? curationOptions.knownProjectTaskId ?? null });
    const combinedRecords = [...base.records, ...rejectedRecords];
    const combinedCounts = mergeCounts(base.counts, { deferred, rejected });
    const snapshot = await recover(curationOptions.taskScopeId ?? curationOptions.knownProjectTaskId ?? null);
    const selectedIds = new Set(eligible.map((candidate) => candidate.memoryId));
    const recoveredIds = new Set(snapshot.records.map((record) => record.memoryId));
    const storedCount = base.records.filter((record) => record.decision === "ADD" || record.decision === "UPDATE" || record.decision === "NOOP").length;
    const recoveryComplete = snapshot.status === "available" && [...selectedIds].every((memoryId) => recoveredIds.has(memoryId) || base.records.some((record) => record.memoryId === memoryId && record.decision === "DEFER"));
    const unresolved = findings.some((finding) => finding.severity !== "info") || combinedCounts.deferred > 0 || combinedCounts.rejected > 0 || base.status === "blocked" || !base.readBackVerified || !recoveryComplete;
    const verdict: CurationQualityVerdict = unresolved ? (base.status === "blocked" || !recoveryComplete ? "HOLD" : "NO") : "PASS";
    const safeToDeleteOriginalChat = verdict === "PASS" && storedCount > 0 ? "YES" : "NO";
    const report: CurationQualityReport = {
      verdict,
      selectedCount,
      eligibleCount: eligible.length,
      storedCount,
      recoveredCount: snapshot.records.length,
      findings,
      improvementCandidates: improvements,
      safeToDeleteOriginalChat,
    };
    return {
      ...base,
      counts: combinedCounts,
      records: combinedRecords,
      safeToDeleteOriginalChat,
      memorySnapshot: snapshot,
      qualityReport: report,
      message: `${base.message}; knowledge-quality=${verdict}; recovered=${snapshot.records.length}`,
    };
  }

  return { curate, recover };
}
