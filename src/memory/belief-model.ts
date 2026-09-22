import { containsSecretShapedValue } from "../domain/manifest-id.js";
import { InvalidTaskStateError } from "../domain/errors.js";
import { isAbsolute } from "node:path";
import type { MemoryProvenance, MemoryRecord, MemoryRecordKind } from "./types.js";

export type ParsedRecordKind = MemoryRecordKind | "legacy/unknown";

export interface ParsedBelief {
  readonly record: MemoryRecord;
  readonly recordKind: "belief" | "legacy/unknown";
  readonly fact: string;
  readonly category: string;
  readonly subjectKey: string;
  readonly revision: number;
  readonly observedAt: string | null;
  readonly projectTaskId: string | null;
  readonly taskScopeId: string | null;
  readonly supersedesMemoryIds: readonly string[];
  readonly critical: boolean;
  readonly topicLabel: string | null;
  readonly provenance: MemoryProvenance | null;
  readonly evidenceRefs: readonly string[];
  readonly assetRefs: readonly string[];
}

export interface BeliefSelection {
  readonly current: readonly ParsedBelief[];
  readonly history: readonly ParsedBelief[];
  readonly equivalentDuplicates: readonly { readonly selected: ParsedBelief; readonly duplicate: ParsedBelief }[];
}

const allowedProvenanceKeys = new Set(["sourceType", "sourceProject", "sourceSession", "sourceCheckpoint", "sourceMarker", "observedAt", "evidenceHash", "createdBy", "derivationVersion", "evidenceRefs"]);
const allowedTopicLabels = new Set(["architecture/decision", "bug/root-cause", "project status", "preference", "workflow/process", "other/transient"]);
const safeSubjectKey = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isSafeDurableReferenceShape(reference: string): boolean {
  if (containsSecretShapedValue(reference) || /(?:password|secret|token|cookie|credential|auth|private-key)/iu.test(reference)) return false;
  const normalizedSegments = reference.replace(/\\/gu, "/").split("/");
  if (normalizedSegments.some((segment) => segment === "..")) return false;
  if (/^https:\/\//iu.test(reference)) {
    try {
      const parsed = new URL(reference);
      return parsed.username.length === 0 && parsed.password.length === 0;
    } catch {
      return false;
    }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) || isAbsolute(reference) || /^\//u.test(reference) || /^[A-Za-z]:[\\/]/u.test(reference) || /^\\\\/u.test(reference) || /^~(?:[\\/]|$)/u.test(reference) || reference.includes("\\")) return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !containsSecretShapedValue(value);
}

function isIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function boundedString(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > limit || containsSecretShapedValue(value)) throw new InvalidTaskStateError(`Belief ${label} is invalid`);
  return value;
}

function referenceList(value: unknown, label: string, typed: boolean): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16 || value.some((reference) => typeof reference !== "string" || reference.trim() !== reference || reference.length === 0 || reference.length > 512 || containsSecretShapedValue(reference))) {
    if (typed) throw new InvalidTaskStateError(`Belief ${label} is invalid`);
    return [];
  }
  return [...value];
}

export function parseRecordKind(value: unknown): ParsedRecordKind {
  if (!isRecord(value)) return "legacy/unknown";
  if (value.recordKind === undefined) return "legacy/unknown";
  if (value.recordKind === "belief" || value.recordKind === "evidence" || value.recordKind === "curation-decision") return value.recordKind;
  throw new InvalidTaskStateError("Memory recordKind is unsupported");
}

export function validateMemoryProvenance(value: unknown, required = false): MemoryProvenance | null {
  if (value === undefined) {
    if (required) throw new InvalidTaskStateError("Strong belief provenance is required");
    return null;
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedProvenanceKeys.has(key))) throw new InvalidTaskStateError("Belief provenance metadata is invalid");
  const result: Record<string, unknown> = {};
  for (const key of ["sourceType", "sourceProject", "sourceSession", "sourceCheckpoint", "sourceMarker", "createdBy", "derivationVersion"] as const) {
    if (value[key] !== undefined) result[key] = boundedString(value[key], `provenance.${key}`, 256);
  }
  if (value.observedAt !== undefined && value.observedAt !== null) {
    const observedAt = boundedString(value.observedAt, "provenance.observedAt", 64);
    if (!isIsoTimestamp(observedAt)) throw new InvalidTaskStateError("Belief provenance observedAt is invalid");
    result.observedAt = observedAt;
  }
  else if (value.observedAt === null) result.observedAt = null;
  if (value.evidenceHash !== undefined) {
    if (typeof value.evidenceHash !== "string" || !/^[0-9a-f]{64}$/u.test(value.evidenceHash)) throw new InvalidTaskStateError("Belief provenance evidenceHash is invalid");
    result.evidenceHash = value.evidenceHash;
  }
  if (value.evidenceRefs !== undefined) {
    if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length > 16 || value.evidenceRefs.some((reference) => typeof reference !== "string" || reference.trim() !== reference || reference.length === 0 || reference.length > 512 || !isSafeDurableReferenceShape(reference))) throw new InvalidTaskStateError("Belief provenance evidenceRefs are invalid");
    result.evidenceRefs = [...value.evidenceRefs];
  }
  if (required && !["sourceType", "sourceProject", "sourceSession", "sourceCheckpoint", "sourceMarker", "observedAt", "evidenceHash"].every((key) => result[key] !== undefined && result[key] !== null)) throw new InvalidTaskStateError("Strong belief provenance is incomplete");
  return result as MemoryProvenance;
}

function exactTaskMatch(value: Record<string, unknown>, projectTaskId: string | null): boolean {
  if (projectTaskId === null) return (value.taskScopeId === undefined || value.taskScopeId === null) && (value.projectTaskId === undefined || value.projectTaskId === null) && value.category !== "project-memory";
  const taskScopeId = value.taskScopeId;
  const projectId = value.projectTaskId;
  if ((taskScopeId === undefined || taskScopeId === null) && (projectId === undefined || projectId === null)) return value.recordKind === undefined && value.category !== "project-memory";
  if (taskScopeId !== undefined && taskScopeId !== null) return taskScopeId === projectTaskId && (projectId === undefined || projectId === null || projectId === projectTaskId);
  return projectId === projectTaskId;
}

export function parseTaskBelief(record: MemoryRecord, projectTaskId: string | null): ParsedBelief | null {
  if (!isRecord(record.value) || !exactTaskMatch(record.value, projectTaskId)) return null;
  const kind = parseRecordKind(record.value);
  if (kind === "evidence" || kind === "curation-decision") {
    validateMemoryProvenance(record.value.provenance);
    if (kind === "evidence") {
      if (record.value.evidenceHash !== undefined && (typeof record.value.evidenceHash !== "string" || !/^[0-9a-f]{64}$/u.test(record.value.evidenceHash))) throw new InvalidTaskStateError(`Evidence hash is invalid for ${record.memoryId}`);
      if (record.value.evidenceRefs !== undefined && (!Array.isArray(record.value.evidenceRefs) || record.value.evidenceRefs.some((reference) => typeof reference !== "string" || reference.trim() !== reference || reference.length === 0 || reference.length > 512 || containsSecretShapedValue(reference)))) throw new InvalidTaskStateError(`Evidence references are invalid for ${record.memoryId}`);
    } else {
      if (typeof record.value.decision !== "string" || !["ADD", "UPDATE", "NOOP", "DEFER", "REJECT", "CONFLICTED"].includes(record.value.decision)) throw new InvalidTaskStateError(`Curation decision is invalid for ${record.memoryId}`);
      if (record.value.targetMemoryId !== undefined && !isSafeId(record.value.targetMemoryId)) throw new InvalidTaskStateError(`Curation decision target is invalid for ${record.memoryId}`);
      if (record.value.reason !== undefined && record.value.reason !== null) boundedString(record.value.reason, "decision.reason", 256);
    }
    return null;
  }
  const typed = kind === "belief";
  if (record.value.kind !== "curated-fact" && !typed) return null;
  const fact = boundedString(record.value.fact, "fact", 16_384);
  const category = boundedString(record.value.category, "category", 64);
  const subjectKey = record.value.subjectKey === undefined && !typed ? record.memoryId : boundedString(record.value.subjectKey, "subjectKey", 128);
  if (!safeSubjectKey.test(subjectKey)) throw new InvalidTaskStateError(`Belief subjectKey is invalid for ${record.memoryId}`);
  const revision = record.value.revision === undefined && !typed ? 1 : record.value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) throw new InvalidTaskStateError(`Belief revision is invalid for ${record.memoryId}`);
  const observedAt = record.value.observedAt === undefined || record.value.observedAt === null ? null : boundedString(record.value.observedAt, "observedAt", 64);
  if (observedAt !== null && !isIsoTimestamp(observedAt)) throw new InvalidTaskStateError(`Belief observedAt is invalid for ${record.memoryId}`);
  const supersedesMemoryIds = record.value.supersedesMemoryIds === undefined && !typed ? [] : record.value.supersedesMemoryIds;
  if (!Array.isArray(supersedesMemoryIds) || supersedesMemoryIds.some((id) => !isSafeId(id))) throw new InvalidTaskStateError(`Belief supersession list is invalid for ${record.memoryId}`);
  if (record.value.critical !== undefined && typeof record.value.critical !== "boolean") throw new InvalidTaskStateError(`Belief critical flag is invalid for ${record.memoryId}`);
  const topicLabel = record.value.topicLabel === undefined ? null : record.value.topicLabel;
  if (typed && record.value.topicLabel !== undefined && (typeof topicLabel !== "string" || !allowedTopicLabels.has(topicLabel))) throw new InvalidTaskStateError(`Belief topicLabel is invalid for ${record.memoryId}`);
  if (!typed && topicLabel !== null && (typeof topicLabel !== "string" || !allowedTopicLabels.has(topicLabel))) throw new InvalidTaskStateError(`Belief topicLabel is invalid for ${record.memoryId}`);
  const provenance = validateMemoryProvenance(record.value.provenance, typed);
  const evidenceRefs = referenceList(record.value.evidenceRefs, "evidenceRefs", typed);
  const assetRefs = referenceList(record.value.assetRefs, "assetRefs", typed);
  return { record, recordKind: typed ? "belief" : "legacy/unknown", fact, category, subjectKey, revision, observedAt, projectTaskId: typeof record.value.projectTaskId === "string" ? record.value.projectTaskId : null, taskScopeId: typeof record.value.taskScopeId === "string" ? record.value.taskScopeId : null, supersedesMemoryIds: [...supersedesMemoryIds], critical: record.value.critical === true, topicLabel: typeof topicLabel === "string" ? topicLabel : null, provenance, evidenceRefs, assetRefs };
}

function freshness(left: ParsedBelief, right: ParsedBelief): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  const observed = (left.observedAt ?? "").localeCompare(right.observedAt ?? "");
  return observed !== 0 ? observed : left.record.memoryId.localeCompare(right.record.memoryId);
}

export function selectTaskBeliefs(records: readonly MemoryRecord[], projectTaskId: string | null, mode: "current" | "audit" = "current"): BeliefSelection {
  const history = records.map((record) => parseTaskBelief(record, projectTaskId)).filter((belief): belief is ParsedBelief => belief !== null).sort((left, right) => left.record.sequence - right.record.sequence || left.record.memoryId.localeCompare(right.record.memoryId));
  const byId = new Map(history.map((belief) => [belief.record.memoryId, belief]));
  const edges = new Map<string, readonly string[]>();
  for (const belief of history) {
    const validTargets: string[] = [];
    for (const targetId of belief.supersedesMemoryIds) {
      const target = byId.get(targetId);
      if (target === undefined) {
        if (belief.recordKind === "belief") throw new InvalidTaskStateError(`Typed belief ${belief.record.memoryId} supersedes a missing target`);
        continue;
      }
      const legacySubjectCompatibility = belief.recordKind === "belief" && target.recordKind === "legacy/unknown";
      if (target.subjectKey !== belief.subjectKey && !legacySubjectCompatibility) throw new InvalidTaskStateError(`Belief ${belief.record.memoryId} has an invalid supersession target ${targetId}`);
      validTargets.push(targetId);
    }
    edges.set(belief.record.memoryId, validTargets);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new InvalidTaskStateError("Belief supersession graph contains a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const target of edges.get(id) ?? []) visit(target);
    visiting.delete(id);
    visited.add(id);
  };
  for (const belief of history) visit(belief.record.memoryId);
  for (const belief of history) for (const targetId of edges.get(belief.record.memoryId) ?? []) {
    const target = byId.get(targetId)!;
    if (freshness(belief, target) <= 0) throw new InvalidTaskStateError(`Belief ${belief.record.memoryId} has an invalid supersession target ${targetId}; unresolved concurrent current beliefs remain`);
  }
  const superseded = new Set(history.flatMap((belief) => edges.get(belief.record.memoryId) ?? []));
  const currentCandidates = history.filter((belief) => !superseded.has(belief.record.memoryId));
  const grouped = new Map<string, ParsedBelief[]>();
  for (const belief of currentCandidates) grouped.set(belief.subjectKey, [...(grouped.get(belief.subjectKey) ?? []), belief]);
  const current: ParsedBelief[] = [];
  const equivalentDuplicates: { selected: ParsedBelief; duplicate: ParsedBelief }[] = [];
  for (const beliefs of grouped.values()) {
    const distinctFacts = new Set(beliefs.map((belief) => belief.fact));
    if (distinctFacts.size > 1) throw new InvalidTaskStateError("Unresolved concurrent current beliefs exist for one subject");
    const selected = [...beliefs].sort(freshness).at(-1)!;
    current.push(selected);
    for (const duplicate of beliefs) if (duplicate !== selected) equivalentDuplicates.push({ selected, duplicate });
  }
  current.sort((left, right) => left.record.sequence - right.record.sequence || left.record.memoryId.localeCompare(right.record.memoryId));
  return { current, history, equivalentDuplicates };
}
