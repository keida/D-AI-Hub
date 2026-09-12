import { containsSecretShapedValue } from "../domain/manifest-id.js";
import type { MemoryMutation, MemoryRecord, MemoryValue } from "../memory/types.js";
import type { CurationQualityReport, MemoryRecoverySnapshot } from "./knowledge-quality-loop.js";

export type CurationCategory = "knowledge" | "project-memory" | "cross-project-memory";
export type CurationPrivacyRisk = "local-private" | "possible-workplace" | "workplace-confidential";
export type CurationDecision = "ADD" | "UPDATE" | "NOOP" | "DEFER" | "REJECT";

export interface CurationCandidate {
  readonly candidateId: string;
  readonly memoryId: string;
  readonly fact: string;
  readonly category: CurationCategory;
  readonly source: "current-context";
  readonly privacyRisk: CurationPrivacyRisk;
  readonly revision?: number;
  readonly projectTaskId?: string;
  readonly subjectKey?: string;
  readonly observedAt?: string;
  readonly supersedesMemoryIds?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly assetRefs?: readonly string[];
}

export interface CurationStore {
  get(memoryId: string): Promise<MemoryRecord | null>;
  applyMutations(mutations: readonly MemoryMutation[]): Promise<readonly MemoryRecord[]>;
}

export interface CurationOptions {
  readonly recordedAt?: string;
  readonly knownProjectTaskId?: string | null;
  readonly taskScopeId?: string | null;
}

export interface CurationRecordResult {
  readonly decision: CurationDecision;
  readonly memoryId: string;
  readonly category: CurationCategory;
  readonly summary: string;
}

export interface CurationResult {
  readonly status: "completed" | "blocked";
  readonly counts: {
    readonly added: number;
    readonly updated: number;
    readonly noOp: number;
    readonly deferred: number;
    readonly rejected: number;
  };
  readonly records: readonly CurationRecordResult[];
  readonly locallyStored: boolean;
  readonly readBackVerified: boolean;
  readonly safeToDeleteOriginalChat: "YES" | "NO";
  readonly message: string;
  readonly qualityReport?: CurationQualityReport;
  readonly memorySnapshot?: MemoryRecoverySnapshot;
}

interface PreparedCandidate {
  readonly candidate: CurationCandidate;
  readonly decision: CurationDecision;
  readonly existing: MemoryRecord | null;
  readonly reason?: string;
}

const emptyCounts = (): { added: number; updated: number; noOp: number; deferred: number; rejected: number } => ({
  added: 0,
  updated: 0,
  noOp: 0,
  deferred: 0,
  rejected: 0,
});

function summary(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`;
}

function isCategory(value: unknown): value is CurationCategory {
  return value === "knowledge" || value === "project-memory" || value === "cross-project-memory";
}

function isPrivacyRisk(value: unknown): value is CurationPrivacyRisk {
  return value === "local-private" || value === "possible-workplace" || value === "workplace-confidential";
}

function assertReferenceList(value: readonly string[] | undefined, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((reference) => typeof reference !== "string" || reference.trim() !== reference || reference.length === 0 || reference.length > 512 || containsSecretShapedValue(reference))) {
    throw new Error(`Curation candidate ${label} must contain bounded non-secret references`);
  }
}

export function assertCurationCandidate(candidate: CurationCandidate): void {
  if (typeof candidate !== "object" || candidate === null
    || typeof candidate.candidateId !== "string"
    || typeof candidate.memoryId !== "string"
    || typeof candidate.fact !== "string"
    || candidate.source !== "current-context"
    || !isCategory(candidate.category)
    || !isPrivacyRisk(candidate.privacyRisk)) {
    throw new Error("Curation candidate must be a current-context durable fact with a supported category and privacy risk");
  }
  if (candidate.candidateId.trim() !== candidate.candidateId || candidate.memoryId.trim() !== candidate.memoryId
    || candidate.fact.trim() !== candidate.fact || candidate.candidateId.length === 0 || candidate.memoryId.length === 0 || candidate.fact.length === 0) {
    throw new Error("Curation candidate identifiers and fact must be non-empty and trimmed");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate.candidateId) || containsSecretShapedValue(candidate.candidateId)) {
    throw new Error("Curation candidate candidateId is not a safe local identifier");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate.memoryId) || containsSecretShapedValue(candidate.memoryId)) {
    throw new Error("Curation candidate memoryId is not a safe local identifier");
  }
  if (containsSecretShapedValue(candidate.fact)) throw new Error("Curation candidate fact contains secret-shaped content");
  if (candidate.revision !== undefined && (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1)) {
    throw new Error("Curation candidate revision must be a positive integer");
  }
  if (candidate.projectTaskId !== undefined && (candidate.projectTaskId.trim() !== candidate.projectTaskId || candidate.projectTaskId.length === 0)) {
    throw new Error("Curation candidate projectTaskId must be a non-empty identifier");
  }
  if (candidate.projectTaskId !== undefined && containsSecretShapedValue(candidate.projectTaskId)) {
    throw new Error("Curation candidate projectTaskId is not a safe local identifier");
  }
  if (candidate.subjectKey !== undefined && (candidate.subjectKey.trim() !== candidate.subjectKey
    || candidate.subjectKey.length === 0 || candidate.subjectKey.length > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.subjectKey)
    || containsSecretShapedValue(candidate.subjectKey))) {
    throw new Error("Curation candidate subjectKey is not a safe local identifier");
  }
  if (candidate.observedAt !== undefined && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(candidate.observedAt)
    || Number.isNaN(Date.parse(candidate.observedAt)) || new Date(candidate.observedAt).toISOString() !== candidate.observedAt)) {
    throw new Error("Curation candidate observedAt must be an ISO timestamp");
  }
  assertReferenceList(candidate.supersedesMemoryIds, "supersedesMemoryIds");
  assertReferenceList(candidate.evidenceRefs, "evidenceRefs");
  assertReferenceList(candidate.assetRefs, "assetRefs");
}

export function validateCurationCandidates(candidates: readonly CurationCandidate[]): void {
  if (!Array.isArray(candidates)) throw new Error("Curation candidates must be an array");
  for (const candidate of candidates) assertCurationCandidate(candidate);
}

function storedObject(value: MemoryValue): { readonly fact?: string; readonly category?: string; readonly revision?: number; readonly projectTaskId?: string | null } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as { readonly fact?: unknown; readonly category?: unknown; readonly revision?: unknown; readonly projectTaskId?: unknown };
  return {
    ...(typeof record.fact === "string" ? { fact: record.fact } : {}),
    ...(typeof record.category === "string" ? { category: record.category } : {}),
    ...(typeof record.revision === "number" ? { revision: record.revision } : {}),
    ...(typeof record.projectTaskId === "string" || record.projectTaskId === null ? { projectTaskId: record.projectTaskId } : {}),
  };
}

function materiallyImproves(candidate: CurationCandidate, existing: MemoryRecord): boolean {
  const stored = storedObject(existing.value);
  if (stored === null || stored.fact === undefined || stored.category !== candidate.category) return false;
  const revision = candidate.revision ?? 1;
  const existingRevision = stored.revision ?? 1;
  return (revision > existingRevision && candidate.fact.length >= stored.fact.length)
    || (candidate.fact.startsWith(stored.fact) && candidate.fact.length > stored.fact.length);
}

function sameConcept(candidate: CurationCandidate, existing: MemoryRecord): boolean {
  const stored = storedObject(existing.value);
  return stored !== null
    && stored.fact === candidate.fact
    && stored.category === candidate.category
    && (stored.projectTaskId ?? null) === (candidate.projectTaskId ?? null);
}

function projectTaskBindingMatches(candidate: CurationCandidate, existing: MemoryRecord): boolean {
  const stored = storedObject(existing.value);
  return stored !== null && (stored.projectTaskId ?? null) === (candidate.projectTaskId ?? null);
}

function valueFor(candidate: CurationCandidate, options: CurationOptions): MemoryValue {
  return {
    kind: "curated-fact",
    candidateId: candidate.candidateId,
    fact: candidate.fact,
    category: candidate.category,
    source: candidate.source,
    privacyRisk: candidate.privacyRisk,
    revision: candidate.revision ?? 1,
    projectTaskId: candidate.projectTaskId ?? null,
    subjectKey: candidate.subjectKey ?? candidate.memoryId,
    observedAt: candidate.observedAt ?? null,
    supersedesMemoryIds: candidate.supersedesMemoryIds === undefined ? [] : [...candidate.supersedesMemoryIds],
    evidenceRefs: candidate.evidenceRefs === undefined ? [] : [...candidate.evidenceRefs],
    assetRefs: candidate.assetRefs === undefined ? [] : [...candidate.assetRefs],
    taskScopeId: options.taskScopeId ?? null,
  };
}

function resultRecords(prepared: readonly PreparedCandidate[]): CurationRecordResult[] {
  return prepared.map(({ candidate, decision }) => ({
    decision,
    memoryId: candidate.memoryId,
    category: candidate.category,
    summary: summary(candidate.fact),
  }));
}

function countsFor(prepared: readonly PreparedCandidate[], includeMutations: boolean): { added: number; updated: number; noOp: number; deferred: number; rejected: number } {
  const counts = emptyCounts();
  for (const { decision } of prepared) {
    if (decision === "ADD" && includeMutations) counts.added += 1;
    if (decision === "UPDATE" && includeMutations) counts.updated += 1;
    if (decision === "NOOP") counts.noOp += 1;
    if (decision === "DEFER") counts.deferred += 1;
    if (decision === "REJECT") counts.rejected += 1;
  }
  return counts;
}

function blockedResult(
  message: string,
  records: readonly CurationRecordResult[] = [],
  counts = emptyCounts(),
): CurationResult {
  return {
    status: "blocked",
    counts,
    records,
    locallyStored: false,
    readBackVerified: false,
    safeToDeleteOriginalChat: "NO",
    message,
  };
}

export async function curateCurrentContext(
  store: CurationStore | null,
  candidates: readonly CurationCandidate[],
  options: CurationOptions = {},
): Promise<CurationResult> {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      ...blockedResult("Current-context candidates are required; chat history was not captured"),
      counts: { ...emptyCounts(), deferred: 1 },
    };
  }

  if (store === null) {
    return blockedResult("Local curation storage is unavailable; no chat history was captured");
  }

  const prepared: PreparedCandidate[] = [];
  try {
    for (const candidate of candidates) {
      assertCurationCandidate(candidate);
      if (candidate.privacyRisk === "workplace-confidential") {
        prepared.push({ candidate, decision: "REJECT", existing: null, reason: "Possible workplace-confidential information is not transferred" });
        continue;
      }
      if (candidate.privacyRisk === "possible-workplace") {
        prepared.push({ candidate, decision: "DEFER", existing: null, reason: "Privacy provenance is ambiguous" });
        continue;
      }
      if (candidate.category === "project-memory" && (candidate.projectTaskId === undefined || options.knownProjectTaskId === undefined || options.knownProjectTaskId === null)) {
        prepared.push({ candidate, decision: "DEFER", existing: null, reason: "Project-memory requires an exact existing task identity" });
        continue;
      }
      if (candidate.category === "project-memory" && candidate.projectTaskId !== options.knownProjectTaskId) {
        prepared.push({ candidate, decision: "DEFER", existing: null, reason: "Project-memory task identity does not match the known project" });
        continue;
      }
      const existing = await store.get(candidate.memoryId);
      if (existing === null) {
        prepared.push({ candidate, decision: "ADD", existing });
      } else if (!projectTaskBindingMatches(candidate, existing)) {
        prepared.push({ candidate, decision: "DEFER", existing, reason: "Existing memory is bound to a different project task" });
      } else if (sameConcept(candidate, existing)) {
        prepared.push({ candidate, decision: "NOOP", existing });
      } else if (materiallyImproves(candidate, existing)) {
        prepared.push({ candidate, decision: "UPDATE", existing });
      } else {
        prepared.push({ candidate, decision: "DEFER", existing, reason: "Existing concept differs without deterministic improvement proof" });
      }
    }
  } catch (error) {
    return blockedResult(`Curation preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const mutations: MemoryMutation[] = prepared
    .filter(({ decision }) => decision === "ADD" || decision === "UPDATE")
    .map(({ candidate, decision }) => ({
      operation: decision === "ADD" ? "add" : "update",
      memoryId: candidate.memoryId,
      value: valueFor(candidate, options),
      recordedAt: options.recordedAt ?? new Date().toISOString(),
    }));
  let applied: readonly MemoryRecord[] = [];
  if (mutations.length > 0) {
    try {
      applied = await store.applyMutations(mutations);
      if (applied.length !== mutations.length) throw new Error("Curation transaction returned an incomplete read-back");
    } catch (error) {
      const retained = prepared.filter(({ decision }) => decision !== "ADD" && decision !== "UPDATE");
      return blockedResult(
        `Curation transaction failed; no safe deletion: ${error instanceof Error ? error.message : String(error)}`,
        resultRecords(retained),
        countsFor(retained, false),
      );
    }
    try {
      for (const record of applied) {
        const readBack = await store.get(record.memoryId);
        if (readBack === null || readBack.valueSha256 !== record.valueSha256 || readBack.sequence !== record.sequence) {
          throw new Error(`Curation post-commit read-back failed for ${record.memoryId}`);
        }
      }
    } catch (error) {
      return {
        status: "blocked",
        counts: countsFor(prepared, true),
        records: resultRecords(prepared),
        locallyStored: applied.length > 0,
        readBackVerified: false,
        safeToDeleteOriginalChat: "NO",
        message: `Curation committed selected facts but post-commit read-back failed; no safe deletion: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const counts = countsFor(prepared, true);
  const locallyStored = applied.length > 0 || counts.noOp > 0;
  const readBackVerified = applied.length === mutations.length
    && (applied.length > 0 || counts.noOp > 0);
  return {
    status: "completed",
    counts,
    records: resultRecords(prepared),
    locallyStored,
    readBackVerified,
    safeToDeleteOriginalChat: locallyStored ? "YES" : "NO",
    message: locallyStored
      ? "Selected durable facts were locally stored or already represented; source chat/transcript was not captured; SAFE TO DELETE ORIGINAL CHAT: YES for selected curated facts only"
      : "No selected durable fact passed persistence; source chat/transcript remains untouched; SAFE TO DELETE ORIGINAL CHAT: NO",
  };
}
