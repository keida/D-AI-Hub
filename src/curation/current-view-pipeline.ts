import { createHash } from "node:crypto";
import { containsSecretShapedValue } from "../domain/manifest-id.js";
import { LocalSqliteMemoryStore } from "../memory/local-sqlite-memory-store.js";
import type { CurationCheckpoint, CurationCoverage, CurrentStateView, MemoryRecord } from "../memory/types.js";
import { createKnowledgeQualityLoop, type CurationQualityFinding, type KnowledgeQualityLoop, type MemoryRecoverySnapshot } from "./knowledge-quality-loop.js";
import { assertCurationCandidate, type CurationCandidate, type CurationResult, type CurationTopicLabel } from "./local-curation.js";

export interface PipelineSourceMessage {
  readonly marker: string;
  readonly text: string;
  readonly observedAt: string;
  readonly memoryId?: string;
  readonly subjectKey?: string;
  readonly revision?: number;
  readonly supersedesMemoryIds?: readonly string[];
  readonly projectTaskId?: string;
  readonly critical?: boolean;
}

export interface CurationPipelineInput {
  readonly sourceType: "conversation";
  readonly sourceKey: string;
  readonly projectTaskId: string;
  readonly messages: readonly PipelineSourceMessage[];
  readonly previousCoveredThroughMarker: string | null;
  readonly previousBoundarySha256: string | null;
  readonly sourceStartAttested: boolean;
  readonly coveredThroughMarker: string;
  readonly boundarySha256: string;
  readonly coverageConfidence: CurationCoverage;
  readonly finalWindow?: boolean;
  readonly trigger?: "window" | "milestone" | "explicit-consolidation" | "source-delete-check";
}

export interface CurationPipelineRecovery {
  readonly status: "available" | "empty" | "blocked";
  readonly projectTaskId: string;
  readonly checkpoint: CurationCheckpoint | null;
  readonly currentView: CurrentStateView | null;
  readonly viewFresh: boolean;
  readonly records: readonly MemoryRecord[];
  readonly reason?: string;
}

export interface CurationFinalizationEvidence {
  readonly earliestTrustedAnchor: { readonly marker: string; readonly boundarySha256: string } | null;
  readonly latestCheckpoint: { readonly checkpointId: string; readonly coveredThroughMarker: string; readonly currentViewVersion: number } | null;
  readonly chainComplete: boolean;
  readonly uncuratedTailCount: number;
  readonly unresolvedCriticalCount: number;
  readonly currentViewFresh: boolean;
  readonly freshRecovery: boolean;
  readonly safeToDeleteSourceChat: "YES" | "NO";
  readonly reason: string;
}

export interface CurationPipelineResult {
  readonly status: "completed" | "blocked";
  readonly mode: "incremental" | "bounded-fallback" | "noop";
  readonly curation: CurationResult | null;
  readonly checkpoint: CurationCheckpoint | null;
  readonly currentView: CurrentStateView | null;
  readonly checkpointAdvanced: boolean;
  readonly checkpointRecorded: boolean;
  readonly coverageAdvanced: boolean;
  readonly consolidated: boolean;
  readonly relatedMemoryIds: readonly string[];
  readonly safeToDeleteSuppliedContent: "YES" | "NO";
  readonly safeToDeleteSourceChat: "YES" | "NO";
  readonly finalization: CurationFinalizationEvidence;
  readonly message: string;
}

export interface CurationPipelineOptions {
  readonly store: LocalSqliteMemoryStore;
  readonly workspacePath: string;
  readonly repositoryPath?: string | null;
  readonly now?: () => string;
  readonly maxWindowMessages?: number;
}

const defaultWindowLimit = 64;
const durableSignal = /(?:decision|approved|approval|authorization|blocker|blocked|bug|root cause|milestone|preference|workflow|process|next action|next step|下一步|接下来|limitation|constraint|revised|supersed|retain|不要 push|只保留|好|可以)/iu;
const transientSignal = /^(?:trace|debug|ephemeral|worker retry|transient tool output)\b/iu;

function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

export function hashCurationSourceKey(sourceKey: string): string { return sha256(sourceKey); }

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("Curation view contains unsupported data");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function boundaryMessage(message: PipelineSourceMessage): Record<string, unknown> {
  return {
    marker: message.marker,
    text: message.text,
    observedAt: message.observedAt,
    memoryId: message.memoryId ?? null,
    subjectKey: message.subjectKey ?? null,
    revision: message.revision ?? null,
    supersedesMemoryIds: message.supersedesMemoryIds === undefined ? null : [...message.supersedesMemoryIds],
    projectTaskId: message.projectTaskId ?? null,
    critical: message.critical ?? null,
  };
}

export function buildCurationBoundarySha256(previousCoveredThroughMarker: string | null, previousBoundarySha256: string | null, messages: readonly PipelineSourceMessage[]): string {
  return sha256(canonicalJson({ previousCoveredThroughMarker, previousBoundarySha256, messages: messages.map(boundaryMessage) }));
}

function markerRank(marker: string): { readonly numeric: number | null; readonly text: string } {
  const suffix = /(?:^|[-_:])(\d+)$/u.exec(marker);
  return suffix === null ? { numeric: null, text: marker } : { numeric: Number(suffix[1]), text: marker };
}

function compareMarkers(left: string, right: string): number {
  const a = markerRank(left); const b = markerRank(right);
  if (a.numeric !== null && b.numeric !== null && a.numeric !== b.numeric) return a.numeric - b.numeric;
  return a.text.localeCompare(b.text);
}

function topicLabel(text: string): CurationTopicLabel {
  if (/^(?:好|可以|yes|no)$/iu.test(text.trim())) return "workflow/process";
  if (/(?:bug|root cause|failure|blocked|blocker)/iu.test(text)) return "bug/root-cause";
  if (/(?:preference|prefer|喜欢|偏好)/iu.test(text)) return "preference";
  if (/(?:workflow|process|不要 push|只保留|整理|authorization|授权)/iu.test(text)) return "workflow/process";
  if (/(?:milestone|status|当前|进展|completed|完成)/iu.test(text)) return "project status";
  if (/(?:decision|approved|approval|supersed|revision|决定)/iu.test(text)) return "architecture/decision";
  return "other/transient";
}

function privacyRisk(text: string): CurationCandidate["privacyRisk"] {
  if (/(?:confidential employer|workplace-confidential|雇主机密)/iu.test(text)) return "workplace-confidential";
  if (/(?:workplace|compensation|salary|employer|工作场所|薪资)/iu.test(text)) return "possible-workplace";
  return "local-private";
}

function deriveMemoryId(message: PipelineSourceMessage): string { return `pipeline-${sha256(`${message.marker}|${message.text}`).slice(0, 32)}`; }

function extractRevision(message: PipelineSourceMessage): number {
  if (message.revision !== undefined) return message.revision;
  const match = /\brevision\s*[=:]\s*(\d+)/iu.exec(message.text);
  return match === null ? 1 : Number(match[1]);
}

function extractSupersessions(message: PipelineSourceMessage): readonly string[] {
  if (message.supersedesMemoryIds !== undefined) return [...message.supersedesMemoryIds];
  const match = /\bsupersedes?\s*[=:]\s*([A-Za-z0-9._,-]+)/iu.exec(message.text);
  return match === null ? [] : match[1]!.split(",").filter(Boolean);
}

export function extractCurationCandidates(messages: readonly PipelineSourceMessage[], projectTaskId: string): readonly CurationCandidate[] {
  const candidates: CurationCandidate[] = [];
  for (const message of messages) {
    const text = message.text.trim();
    if (text.length === 0 || transientSignal.test(text) && message.memoryId === undefined) continue;
    const critical = message.critical === true || /^(?:好|可以|yes|no|不要 push|只保留)/iu.test(text) || /(?:destructive|merge)\s+authorization/iu.test(text);
    if (!critical && message.memoryId === undefined && !durableSignal.test(text)) continue;
    const memoryId = message.memoryId ?? deriveMemoryId(message);
    const candidate: CurationCandidate = {
      candidateId: `${memoryId}-${message.marker}`.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 128),
      memoryId,
      fact: text,
      category: "project-memory",
      source: "current-context",
      privacyRisk: privacyRisk(text),
      topicLabel: topicLabel(text),
      critical,
      projectTaskId: message.projectTaskId ?? projectTaskId,
      subjectKey: message.subjectKey ?? memoryId,
      revision: extractRevision(message),
      observedAt: message.observedAt,
      supersedesMemoryIds: extractSupersessions(message),
    };
    assertCurationCandidate(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

function checkpointId(store: LocalSqliteMemoryStore, input: CurationPipelineInput, sourceKeySha256: string): string { return `cp-${sha256(`${store.scopeId}|${input.sourceType}|${sourceKeySha256}|${input.projectTaskId}`).slice(0, 32)}`; }

function taskMatches(record: MemoryRecord, projectTaskId: string): boolean {
  if (typeof record.value !== "object" || record.value === null || Array.isArray(record.value)) return false;
  const value = record.value as { readonly projectTaskId?: unknown; readonly taskScopeId?: unknown };
  return value.taskScopeId === projectTaskId || value.projectTaskId === projectTaskId;
}

interface StoredViewFact { readonly record: MemoryRecord; readonly fact: string; readonly subjectKey: string; readonly topicLabel: CurationTopicLabel; readonly supersedes: readonly string[] }

function explicitNextAction(fact: string): string | null {
  const match = /(?:\b(?:next action|next step)\s*(?:[:：]\s*|\bis\s+)|(?:下一步|接下来)(?:：\s*|是\s*|要\s*))(.+)$/iu.exec(fact);
  const remainder = match?.[1]?.trim();
  return remainder === undefined || remainder.length === 0 ? null : remainder.slice(0, 256);
}

function storedViewFacts(records: readonly MemoryRecord[], projectTaskId: string): readonly StoredViewFact[] {
  return records.flatMap((record) => {
    if (!taskMatches(record, projectTaskId) || typeof record.value !== "object" || record.value === null || Array.isArray(record.value)) return [];
    const value = record.value as { readonly kind?: unknown; readonly fact?: unknown; readonly subjectKey?: unknown; readonly topicLabel?: unknown; readonly supersedesMemoryIds?: unknown };
    if (value.kind !== "curated-fact" || typeof value.fact !== "string") return [];
    const label = value.topicLabel;
    const accepted: CurationTopicLabel = label === "architecture/decision" || label === "bug/root-cause" || label === "project status" || label === "preference" || label === "workflow/process" || label === "other/transient" ? label : topicLabel(value.fact);
    return [{ record, fact: value.fact, subjectKey: typeof value.subjectKey === "string" ? value.subjectKey : record.memoryId, topicLabel: accepted, supersedes: Array.isArray(value.supersedesMemoryIds) ? value.supersedesMemoryIds.filter((id): id is string => typeof id === "string") : [] }];
  });
}

function buildCurrentView(records: readonly MemoryRecord[], projectTaskId: string, reference: string, version: number, verificationStatus: CurrentStateView["verificationStatus"]): CurrentStateView {
  const facts = storedViewFacts(records, projectTaskId);
  const superseded = new Set(facts.flatMap((fact) => fact.supersedes));
  const current = facts.filter((fact) => !superseded.has(fact.record.memoryId)).sort((left, right) => left.record.sequence - right.record.sequence || left.record.memoryId.localeCompare(right.record.memoryId));
  const texts = (predicate: (fact: StoredViewFact) => boolean): readonly string[] => current.filter(predicate).map(({ fact }) => fact.slice(0, 256));
  let nextAction: string | null = null;
  for (const { fact } of [...current].reverse()) {
    const candidate = explicitNextAction(fact);
    if (candidate !== null) {
      nextAction = candidate;
      break;
    }
  }
  return {
    identity: projectTaskId,
    phase: "curated",
    milestones: texts(({ fact, topicLabel: label }) => label === "project status" && /milestone|completed|完成|closed/iu.test(fact)),
    currentWork: texts(({ fact }) => /current work|working|in progress|当前工作/iu.test(fact)),
    confirmedDecisions: texts(({ fact, topicLabel: label }) => label === "architecture/decision" || /decision|approved|approval|决定/iu.test(fact)),
    blockers: texts(({ fact, topicLabel: label }) => label === "bug/root-cause" || /blocker|blocked|failure|阻塞/iu.test(fact)),
    limitations: texts(({ fact, topicLabel: label }) => label === "other/transient" && /limitation|constraint|cannot|not verified|限制/iu.test(fact)),
    nextAction,
    verificationStatus,
    relevantMemoryIds: current.map(({ record }) => record.memoryId),
    checkpointReference: reference,
  };
}

function unresolvedCriticalIds(previous: readonly string[], candidates: readonly CurationCandidate[], result: CurationResult): readonly string[] {
  const decisions = new Map(result.records.map((record) => [record.memoryId, record.decision]));
  const resolved = new Set(result.records.filter(({ decision }) => ["ADD", "UPDATE", "NOOP"].includes(decision)).map(({ memoryId }) => memoryId));
  const current = candidates.filter((candidate) => candidate.critical === true && !["ADD", "UPDATE", "NOOP"].includes(decisions.get(candidate.memoryId) ?? "")).map(({ memoryId }) => memoryId);
  return [...new Set([...previous.filter((memoryId) => !resolved.has(memoryId)), ...current])];
}

function shouldConsolidate(input: CurationPipelineInput, newlyRetainedCount: number, unresolvedCount: number): boolean {
  return input.trigger === "milestone" || input.trigger === "explicit-consolidation" || input.trigger === "source-delete-check" || input.messages.some(({ text }) => /整理完成|milestone|consolidat/iu.test(text)) || newlyRetainedCount >= 20 || unresolvedCount >= 5;
}

function safeSupplied(result: CurationResult): "YES" | "NO" { return result.status === "completed" && result.readBackVerified && result.qualityReport?.verdict === "PASS" ? "YES" : "NO"; }

function finalizationRequested(input: CurationPipelineInput): boolean { return input.finalWindow === true && input.trigger === "source-delete-check"; }

function uncuratedTailCount(input: CurationPipelineInput, latest: CurationCheckpoint | null): number {
  return latest === null ? input.messages.length : input.messages.filter(({ marker }) => compareMarkers(marker, latest.coveredThroughMarker) > 0).length;
}

function recoveryFinalizationReason(recovered: CurationPipelineRecovery | null): string | undefined {
  if (recovered?.status !== "blocked") return undefined;
  return recovered.reason === "Current-state view hash is stale or unverified" || recovered.reason === "Current-state view content is stale relative to relevant memory" ? undefined : "Fresh current-state recovery failed";
}

function validIdentifier(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && !containsSecretShapedValue(value); }

function validSourceKey(value: string): boolean { return value.trim() === value && value.length > 0 && value.length <= 128 && validIdentifier(value); }

function validSourceMessage(message: PipelineSourceMessage): boolean {
  return message.marker.trim() === message.marker && message.marker.length > 0 && message.marker.length <= 256 && !containsSecretShapedValue(message.marker)
    && message.text.length <= 16_384 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(message.observedAt) && !Number.isNaN(Date.parse(message.observedAt)) && new Date(message.observedAt).toISOString() === message.observedAt
    && (message.memoryId === undefined || validIdentifier(message.memoryId))
    && (message.subjectKey === undefined || (message.subjectKey.trim() === message.subjectKey && message.subjectKey.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(message.subjectKey) && !containsSecretShapedValue(message.subjectKey)))
    && (message.projectTaskId === undefined || validIdentifier(message.projectTaskId))
    && (message.revision === undefined || (Number.isSafeInteger(message.revision) && message.revision > 0))
    && (message.critical === undefined || typeof message.critical === "boolean")
    && (message.supersedesMemoryIds === undefined || (Array.isArray(message.supersedesMemoryIds) && message.supersedesMemoryIds.every(validIdentifier)));
}

function numericMarkerGap(previous: string, current: string): boolean {
  const left = markerRank(previous); const right = markerRank(current);
  const leftPrefix = previous.replace(/\d+$/u, ""); const rightPrefix = current.replace(/\d+$/u, "");
  return left.numeric !== null && right.numeric !== null && leftPrefix === rightPrefix && right.numeric !== left.numeric + 1;
}

function finalizationEvidence(checkpoint: CurationCheckpoint | null, requested: boolean, overrides: { readonly uncuratedTailCount?: number; readonly currentViewFresh?: boolean; readonly freshRecovery?: boolean; readonly reason?: string } = {}): CurationFinalizationEvidence {
  const anchor = checkpoint?.earliestTrustedMarker !== null && checkpoint?.earliestTrustedBoundarySha256 !== null && checkpoint !== null
    ? { marker: checkpoint.earliestTrustedMarker, boundarySha256: checkpoint.earliestTrustedBoundarySha256 }
    : null;
  const chainComplete = checkpoint?.coverageChainComplete === true && anchor !== null;
  const uncuratedTailCount = overrides.uncuratedTailCount ?? 0;
  const unresolvedCriticalCount = checkpoint?.unresolvedCriticalIds.length ?? 0;
  const currentViewFresh = overrides.currentViewFresh ?? false;
  const freshRecovery = overrides.freshRecovery ?? false;
  const safe = requested && chainComplete && checkpoint?.coverageConfidence === "complete" && uncuratedTailCount === 0 && unresolvedCriticalCount === 0 && currentViewFresh && freshRecovery;
  const reason = overrides.reason ?? (!requested
    ? "Source-chat finalization was not requested"
    : anchor === null
      ? "Earliest trusted source boundary is unknown"
      : !chainComplete
        ? "Trusted source coverage chain is incomplete"
        : checkpoint?.coverageConfidence !== "complete"
          ? "Trusted source coverage is incomplete"
          : uncuratedTailCount > 0
            ? "Uncurated source tail remains"
            : unresolvedCriticalCount > 0
              ? "Unresolved critical curation items remain"
              : !currentViewFresh
                ? "Current-state view is stale or unverified"
                : !freshRecovery
                  ? "Fresh current-state recovery failed"
                  : "Fresh whole-source coverage verified");
  return {
    earliestTrustedAnchor: anchor,
    latestCheckpoint: checkpoint === null ? null : { checkpointId: checkpoint.checkpointId, coveredThroughMarker: checkpoint.coveredThroughMarker, currentViewVersion: checkpoint.currentViewVersion },
    chainComplete,
    uncuratedTailCount,
    unresolvedCriticalCount,
    currentViewFresh,
    freshRecovery,
    safeToDeleteSourceChat: safe ? "YES" : "NO",
    reason,
  };
}

function blockedResult(message: string, curation: CurationResult | null = null, checkpoint: CurationCheckpoint | null = null, requested = false, overrides: { readonly uncuratedTailCount?: number; readonly currentViewFresh?: boolean; readonly freshRecovery?: boolean } = {}): CurationPipelineResult {
  return { status: "blocked", mode: "bounded-fallback", curation, checkpoint, currentView: checkpoint?.currentView ?? null, checkpointAdvanced: false, checkpointRecorded: false, coverageAdvanced: false, consolidated: false, relatedMemoryIds: [], safeToDeleteSuppliedContent: "NO", safeToDeleteSourceChat: "NO", finalization: finalizationEvidence(checkpoint, requested, { ...overrides, reason: message }), message };
}

export function createCurationPipeline(options: CurationPipelineOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const loopOptions = { store: options.store, workspacePath: options.workspacePath, repositoryPath: options.repositoryPath ?? null, maxSnapshotRecords: 256 };
  const loop: KnowledgeQualityLoop = createKnowledgeQualityLoop(options.now === undefined ? loopOptions : { ...loopOptions, now: options.now });
  const windowLimit = options.maxWindowMessages ?? defaultWindowLimit;

  async function relatedContext(candidates: readonly CurationCandidate[], projectTaskId: string): Promise<{ readonly candidates: readonly CurationCandidate[]; readonly ids: readonly string[] }> {
    const union = new Set<string>();
    const enriched = candidates.map((candidate) => ({ candidate, related: options.store.retrieveRelatedMemories({ memoryId: candidate.memoryId, subjectKey: candidate.subjectKey ?? candidate.memoryId, projectTaskId, category: candidate.category, limit: 8 }) }));
    const resolved: CurationCandidate[] = [];
    for (const item of enriched) {
      if (union.size < 32) {
        const records = await item.related;
        const ids: string[] = [];
        for (const record of records) {
          if (!union.has(record.memoryId)) union.add(record.memoryId);
          if (!ids.includes(record.memoryId)) ids.push(record.memoryId);
          if (ids.length === 8 || union.size === 32) break;
        }
        resolved.push({ ...item.candidate, relatedMemoryIds: ids });
      } else {
        resolved.push({ ...item.candidate, relatedMemoryIds: [] });
      }
    }
    return { candidates: resolved, ids: [...union] };
  }

  async function boundedFallback(input: CurationPipelineInput, candidates: readonly CurationCandidate[], reason: string, latest: CurationCheckpoint | null): Promise<CurationPipelineResult> {
    const requested = finalizationRequested(input);
    const tailCount = uncuratedTailCount(input, latest);
    if (input.coverageConfidence !== "complete") {
      try {
        const context = await relatedContext(candidates, input.projectTaskId);
        const curation = await loop.curate(context.candidates, { knownProjectTaskId: input.projectTaskId, taskScopeId: input.projectTaskId, recordedAt: now() });
        if (curation.status === "blocked") throw new Error(curation.message);
        return { status: "completed", mode: "bounded-fallback", curation, checkpoint: latest, currentView: latest?.currentView ?? null, checkpointAdvanced: false, checkpointRecorded: false, coverageAdvanced: false, consolidated: false, relatedMemoryIds: context.ids, safeToDeleteSuppliedContent: safeSupplied(curation), safeToDeleteSourceChat: "NO", finalization: finalizationEvidence(latest, requested, { uncuratedTailCount: tailCount, reason }), message: `${reason}; partial content curated without changing verified coverage; source-chat deletion remains NO` };
      } catch (error) {
        return blockedResult(`${reason}; partial handling failed closed: ${error instanceof Error ? error.message : String(error)}`, null, latest, requested, { uncuratedTailCount: tailCount });
      }
    }
    try {
      const context = await relatedContext(candidates, input.projectTaskId);
      const curationWithContext = await loop.curate(context.candidates, { knownProjectTaskId: input.projectTaskId, taskScopeId: input.projectTaskId, recordedAt: now() });
      return { status: curationWithContext.status, mode: "bounded-fallback", curation: curationWithContext, checkpoint: latest, currentView: latest?.currentView ?? null, checkpointAdvanced: false, checkpointRecorded: false, coverageAdvanced: false, consolidated: false, relatedMemoryIds: context.ids, safeToDeleteSuppliedContent: safeSupplied(curationWithContext), safeToDeleteSourceChat: "NO", finalization: finalizationEvidence(latest, requested, { uncuratedTailCount: tailCount, reason }), message: `${reason}; bounded supplied-window handling only; source-chat deletion remains NO` };
    } catch (error) {
      return blockedResult(`${reason}; bounded handling failed closed: ${error instanceof Error ? error.message : String(error)}`, null, latest, requested, { uncuratedTailCount: tailCount });
    }
  }

  async function run(input: CurationPipelineInput): Promise<CurationPipelineResult> {
    const requested = finalizationRequested(input);
    if (input.sourceType !== "conversation" || !validSourceKey(input.sourceKey)) return blockedResult("Curation source identity is invalid; no source content was deleted");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(input.projectTaskId) || containsSecretShapedValue(input.projectTaskId)) return blockedResult("Curation project task identity is invalid; no source content was deleted");
    if (input.messages.length === 0 || input.messages.length > windowLimit) return blockedResult("Curation supplied window is empty or exceeds the bounded window limit; no source content was deleted");
    if (input.messages.some((message) => !validSourceMessage(message))) return blockedResult("Curation source message is invalid; no source content was deleted");
    if ((input.previousCoveredThroughMarker === null) !== (input.previousBoundarySha256 === null) || (input.previousCoveredThroughMarker !== null && (input.previousCoveredThroughMarker.trim() !== input.previousCoveredThroughMarker || input.previousCoveredThroughMarker.length === 0 || input.previousCoveredThroughMarker.length > 256 || containsSecretShapedValue(input.previousCoveredThroughMarker))) || (input.previousBoundarySha256 !== null && !/^[0-9a-f]{64}$/u.test(input.previousBoundarySha256))) return blockedResult("Curation previous boundary linkage is invalid; no source content was deleted");
    if (typeof input.sourceStartAttested !== "boolean" || (!input.sourceStartAttested && input.previousCoveredThroughMarker === null) || (input.sourceStartAttested && input.previousCoveredThroughMarker !== null)) return blockedResult("Curation source-start attestation is invalid; no source content was deleted");
    if (!/^[0-9a-f]{64}$/u.test(input.boundarySha256) || buildCurationBoundarySha256(input.previousCoveredThroughMarker, input.previousBoundarySha256, input.messages) !== input.boundarySha256) return blockedResult("Curation boundary digest does not match the canonical supplied window; no source content was deleted");
    if (input.coverageConfidence !== "complete" && input.coverageConfidence !== "partial" && input.coverageConfidence !== "unknown") return blockedResult("Curation coverage confidence is invalid; no source content was deleted");
    if (input.messages.some((message, index) => message.marker.trim() !== message.marker || message.marker.length === 0 || (index > 0 && (compareMarkers(input.messages[index - 1]!.marker, message.marker) >= 0 || numericMarkerGap(input.messages[index - 1]!.marker, message.marker))))) return blockedResult("Curation source markers are not strictly monotonic or contiguous; no source content was deleted");
    if (input.messages.at(-1)!.marker !== input.coveredThroughMarker) return blockedResult("Curation covered-through marker does not match the supplied window; no source content was deleted");

    const candidates = extractCurationCandidates(input.messages, input.projectTaskId);
    const sourceHash = hashCurationSourceKey(input.sourceKey);
    let latest: CurationCheckpoint | null = null;
    try { latest = await options.store.getLatestCurationCheckpoint(input.sourceType, input.projectTaskId, sourceHash); } catch (error) { return boundedFallback(input, candidates, `Curation checkpoint read failed: ${error instanceof Error ? error.message : String(error)}`, null); }
    if (latest !== null) {
      const markerOrder = compareMarkers(input.coveredThroughMarker, latest.coveredThroughMarker);
      if (markerOrder === 0 && input.boundarySha256 === latest.boundarySha256 && latest.coverageConfidence === "complete" && latest.currentView.verificationStatus === "verified") {
        const recovered = requested ? await recover(input.projectTaskId, input.sourceType, input.sourceKey) : null;
        const recoveryReason = recoveryFinalizationReason(recovered);
        const finalization = finalizationEvidence(latest, requested, { uncuratedTailCount: 0, currentViewFresh: recovered?.viewFresh === true, freshRecovery: recovered?.status === "available" && recovered.viewFresh, ...(recoveryReason === undefined ? {} : { reason: recoveryReason }) });
        return { status: "completed", mode: "noop", curation: null, checkpoint: latest, currentView: latest.currentView, checkpointAdvanced: false, checkpointRecorded: false, coverageAdvanced: false, consolidated: false, relatedMemoryIds: [], safeToDeleteSuppliedContent: latest.unresolvedCriticalIds.length === 0 ? "YES" : "NO", safeToDeleteSourceChat: finalization.safeToDeleteSourceChat, finalization, message: `Curation repeat window is a verified NOOP; no memory or checkpoint change; ${finalization.reason}` };
      }
      if (markerOrder === 0) return blockedResult("Curation same-marker window has a different verified boundary; no source content was deleted", null, latest);
    }
    if (latest === null && input.previousCoveredThroughMarker !== null) return blockedResult("Curation previous linkage has no matching verified checkpoint; no source content was deleted");
    if (latest !== null && (input.previousCoveredThroughMarker !== latest.coveredThroughMarker || input.previousBoundarySha256 !== latest.boundarySha256)) return blockedResult("Curation previous marker/boundary does not match the latest verified checkpoint; no source content was deleted", null, latest, requested, { uncuratedTailCount: uncuratedTailCount(input, latest) });
    if (latest === null && markerRank(input.messages[0]!.marker).numeric !== null && markerRank(input.messages[0]!.marker).numeric !== 1) return blockedResult("Curation first numeric marker does not attest source start; no source content was deleted", null, null, requested, { uncuratedTailCount: input.messages.length });
    if (latest !== null && compareMarkers(input.messages[0]!.marker, latest.coveredThroughMarker) > 0 && numericMarkerGap(latest.coveredThroughMarker, input.messages[0]!.marker)) return blockedResult("Curation source marker gap detected; no source content was deleted", null, latest, requested, { uncuratedTailCount: uncuratedTailCount(input, latest) });
    if (latest !== null && compareMarkers(input.coveredThroughMarker, latest.coveredThroughMarker) < 0) return blockedResult("Curation source marker rollback detected; no source content was deleted", null, latest, requested, { uncuratedTailCount: 0 });
    if (latest !== null && latest.coverageConfidence !== "complete") return boundedFallback(input, candidates, `Curation checkpoint coverage is ${latest.coverageConfidence}; whole-source coverage failed closed`, latest);
    if (input.coverageConfidence !== "complete") return boundedFallback(input, candidates, `Curation coverage is ${input.coverageConfidence}; bounded supplied-window handling only`, latest);
    const newMessages = latest === null ? input.messages : input.messages.filter(({ marker }) => compareMarkers(marker, latest!.coveredThroughMarker) > 0);
    if (newMessages.length === 0) return boundedFallback(input, candidates, "Curation window contains no new markers; no checkpoint advancement", latest);
    const newCandidates = latest === null ? candidates : extractCurationCandidates(newMessages, input.projectTaskId);
    let pendingCheckpoint: CurationCheckpoint | null = null;
    let curation: CurationResult | null = null;
    let consolidated = false;
    let recovered: MemoryRecoverySnapshot | null = null;
    try {
      const context = await relatedContext(newCandidates, input.projectTaskId);
      const relatedMemoryIds = context.ids;
      const committed = await options.store.withCurationCheckpoint(() => {
        if (pendingCheckpoint === null) throw new Error("Curation checkpoint was not prepared");
        return pendingCheckpoint;
      }, async () => {
        const result = await loop.curate(context.candidates, { knownProjectTaskId: input.projectTaskId, taskScopeId: input.projectTaskId, recordedAt: now() });
        curation = result;
        if (result.status === "blocked") throw new Error(`Curation quality/persistence failed closed: ${result.message}`);
        recovered = await loop.recover(input.projectTaskId);
        if (recovered.status === "blocked") throw new Error(`Curation recovery failed closed: ${recovered.reason ?? "unknown recovery failure"}`);
        const records = await options.store.listAll();
        const unresolved = unresolvedCriticalIds(latest?.unresolvedCriticalIds ?? [], newCandidates, result);
        const newlyRetainedCount = (latest?.newRetainedSinceConsolidation ?? 0) + result.counts.added + result.counts.updated;
        const consolidateNow = shouldConsolidate(input, newlyRetainedCount, unresolved.length);
        const refreshView = latest === null || result.counts.added > 0 || result.counts.updated > 0 || consolidateNow;
        consolidated = consolidateNow;
        const id = checkpointId(options.store, input, sourceHash);
        const viewVersion = refreshView ? (latest?.currentViewVersion ?? 0) + 1 : latest!.currentViewVersion;
        const view = refreshView ? buildCurrentView(records, input.projectTaskId, id, viewVersion, unresolved.length === 0 ? "verified" : "unverified") : latest!.currentView;
        const sequence = records.reduce((maximum, record) => Math.max(maximum, record.sequence), 0);
        const trustedStart = latest === null && input.sourceStartAttested && input.previousCoveredThroughMarker === null && input.previousBoundarySha256 === null && input.coverageConfidence === "complete";
        pendingCheckpoint = { checkpointId: id, scopeId: options.store.scopeId, sourceType: input.sourceType, sourceKeySha256: sourceHash, coveredThroughMarker: input.coveredThroughMarker, boundarySha256: input.boundarySha256, lastCuratedAt: now(), lastCandidateIds: newCandidates.map(({ memoryId }) => memoryId), unresolvedCriticalIds: unresolved, relevantMemoryIds: view.relevantMemoryIds, projectTaskId: input.projectTaskId, coverageConfidence: input.coverageConfidence, lastCommittedMemorySequence: sequence, currentViewVersion: viewVersion, newRetainedSinceConsolidation: consolidateNow ? 0 : newlyRetainedCount, currentView: view, currentViewSha256: "", checkpointSha256: "", earliestTrustedMarker: trustedStart ? input.coveredThroughMarker : latest?.earliestTrustedMarker ?? null, earliestTrustedBoundarySha256: trustedStart ? input.boundarySha256 : latest?.earliestTrustedBoundarySha256 ?? null, coverageChainComplete: trustedStart ? true : latest?.coverageChainComplete ?? false };
        return result;
      });
      const checkpoint = committed.checkpoint;
      const committedCuration = curation;
      if (committedCuration === null) throw new Error("Curation result was not prepared");
      const freshRecovery = requested ? await recover(input.projectTaskId, input.sourceType, input.sourceKey) : null;
      const recoveryReason = recoveryFinalizationReason(freshRecovery);
      const finalization = finalizationEvidence(checkpoint, requested, { uncuratedTailCount: 0, currentViewFresh: freshRecovery?.viewFresh === true, freshRecovery: freshRecovery?.status === "available" && freshRecovery.viewFresh, ...(recoveryReason === undefined ? {} : { reason: recoveryReason }) });
      return { status: "completed", mode: "incremental", curation: committedCuration, checkpoint, currentView: checkpoint.currentView, checkpointAdvanced: true, checkpointRecorded: true, coverageAdvanced: true, consolidated, relatedMemoryIds, safeToDeleteSuppliedContent: safeSupplied(committedCuration), safeToDeleteSourceChat: finalization.safeToDeleteSourceChat, finalization, message: `Curation pipeline committed memory and checkpoint atomically; related-context=${relatedMemoryIds.length}; consolidated=${consolidated ? "YES" : "NO"}; SAFE TO DELETE SUPPLIED CONTENT: ${safeSupplied(committedCuration)}; SAFE TO DELETE SOURCE CHAT: ${finalization.safeToDeleteSourceChat}; ${finalization.reason}` };
    } catch (error) {
      return blockedResult(`Curation atomic unit failed closed; checkpoint did not advance: ${error instanceof Error ? error.message : String(error)}`, curation, latest, requested, { uncuratedTailCount: uncuratedTailCount(input, latest) });
    }
  }

  async function recover(projectTaskId: string, sourceType: "conversation" = "conversation", sourceKey?: string): Promise<CurationPipelineRecovery> {
    if (sourceKey === undefined || !validSourceKey(sourceKey)) return { status: "blocked", projectTaskId, checkpoint: null, currentView: null, viewFresh: false, records: [], reason: "Exact source identity is required for current-state recovery" };
    let checkpoint: CurationCheckpoint | null;
    try { checkpoint = await options.store.getLatestCurationCheckpoint(sourceType, projectTaskId, hashCurationSourceKey(sourceKey)); } catch (error) { return { status: "blocked", projectTaskId, checkpoint: null, currentView: null, viewFresh: false, records: [], reason: error instanceof Error ? error.message : String(error) }; }
    if (checkpoint === null) return { status: "empty", projectTaskId, checkpoint: null, currentView: null, viewFresh: false, records: [] };
    const viewFresh = sha256(canonicalJson(checkpoint.currentView)) === checkpoint.currentViewSha256 && checkpoint.currentView.verificationStatus === "verified";
    if (!viewFresh) return { status: "blocked", projectTaskId, checkpoint, currentView: checkpoint.currentView, viewFresh: false, records: [], reason: "Current-state view hash is stale or unverified" };
    try {
      const records = (await Promise.all(checkpoint.relevantMemoryIds.map((memoryId) => options.store.get(memoryId)))).filter((record): record is MemoryRecord => record !== null && taskMatches(record, projectTaskId));
      if (records.length !== checkpoint.relevantMemoryIds.length) return { status: "blocked", projectTaskId, checkpoint, currentView: checkpoint.currentView, viewFresh: false, records: [], reason: "Current-state view references missing or cross-project memory" };
      const regenerated = buildCurrentView(records, projectTaskId, checkpoint.checkpointId, checkpoint.currentViewVersion, "verified");
      if (canonicalJson(regenerated) !== canonicalJson(checkpoint.currentView)) return { status: "blocked", projectTaskId, checkpoint, currentView: checkpoint.currentView, viewFresh: false, records: [], reason: "Current-state view content is stale relative to relevant memory" };
      return { status: records.length === 0 ? "empty" : "available", projectTaskId, checkpoint, currentView: checkpoint.currentView, viewFresh: true, records };
    } catch (error) { return { status: "blocked", projectTaskId, checkpoint, currentView: checkpoint.currentView, viewFresh: false, records: [], reason: error instanceof Error ? error.message : String(error) }; }
  }

  async function refreshView(projectTaskId: string, sourceType: "conversation" = "conversation", sourceKey?: string): Promise<CurationPipelineRecovery> {
    if (sourceKey === undefined || !validSourceKey(sourceKey)) return { status: "blocked", projectTaskId, checkpoint: null, currentView: null, viewFresh: false, records: [], reason: "Exact source identity is required for current-state view refresh" };
    let before: CurationCheckpoint | null;
    try { before = await options.store.getCurationCheckpointForViewRefresh(sourceType, projectTaskId, hashCurationSourceKey(sourceKey)); } catch (error) { return { status: "blocked", projectTaskId, checkpoint: null, currentView: null, viewFresh: false, records: [], reason: error instanceof Error ? error.message : String(error) }; }
    if (before === null) return { status: "empty", projectTaskId, checkpoint: null, currentView: null, viewFresh: false, records: [] };
    let pending: CurationCheckpoint | null = null;
    try {
      const snapshot = await loop.recover(projectTaskId);
      if (snapshot.status === "blocked") throw new Error(snapshot.reason ?? "Current-state view recovery failed");
      const records = await options.store.listAll();
      const refreshedView = buildCurrentView(records, projectTaskId, before.checkpointId, before.currentViewVersion, "verified");
      const sameRelevantIds = canonicalJson(refreshedView.relevantMemoryIds) === canonicalJson(before.relevantMemoryIds);
      const viewHashValid = sha256(canonicalJson(before.currentView)) === before.currentViewSha256;
      if (viewHashValid && before.currentView.verificationStatus === "verified" && sameRelevantIds && canonicalJson(refreshedView) === canonicalJson(before.currentView)) return recover(projectTaskId, sourceType, sourceKey);
      const nextVersion = before.currentViewVersion + 1;
      const nextView = buildCurrentView(records, projectTaskId, before.checkpointId, nextVersion, "verified");
      pending = { ...before, currentViewVersion: nextVersion, currentView: nextView, lastCuratedAt: now(), relevantMemoryIds: nextView.relevantMemoryIds, lastCommittedMemorySequence: records.reduce((maximum, record) => Math.max(maximum, record.sequence), 0) };
      await options.store.withCurationCheckpoint(() => {
        if (pending === null) throw new Error("Current-state view refresh was not prepared");
        return pending;
      }, async () => undefined);
    } catch (error) { return { status: "blocked", projectTaskId, checkpoint: before, currentView: before.currentView, viewFresh: false, records: [], reason: error instanceof Error ? error.message : String(error) }; }
    return recover(projectTaskId, sourceType, sourceKey);
  }

  return { run, recover, refreshView };
}
