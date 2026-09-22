import { containsSecretShapedValue } from "../domain/manifest-id.js";
import { parseTaskBelief } from "../memory/belief-model.js";
import type { CurrentStateView } from "../memory/types.js";
import type { TaskState } from "../domain/types.js";
import type { CurationPipelineRebuild } from "../curation/current-view-pipeline.js";

export type BossSessionMode = "startup" | "prepare";
export type BossSessionDecision = "CONTINUE_CURRENT_BOSS" | "ROLLOVER_RECOMMENDED" | "ROLLOVER_PREPARED" | "BLOCKED";

export interface BossSessionSignals {
  readonly explicitRollover?: boolean;
  readonly milestone?: boolean;
  readonly phaseTransition?: boolean;
  readonly acceptedTicketCount?: number;
}

export interface BossSessionPolicy {
  readonly acceptedTicketThreshold: number;
}

export const defaultBossSessionPolicy: BossSessionPolicy = { acceptedTicketThreshold: 10 };

export interface BossRecoveryContext {
  readonly project: string;
  readonly taskId: string;
  readonly phase: string | null;
  readonly currentStateVersion: number | null;
  readonly checkpointReference: string | null;
  readonly accepted: {
    readonly milestones: readonly string[];
    readonly currentWork: readonly string[];
    readonly confirmedDecisions: readonly string[];
  };
  readonly blockers: readonly string[];
  readonly limitations: readonly string[];
  readonly limitationsPresentation: {
    readonly totalCount: number;
    readonly inlineCount: number;
    readonly omittedCount: number;
    readonly omittedMemoryIds: readonly string[];
    readonly remainingOmittedReferenceCount: number;
    readonly truncatedCount: number;
    readonly truncatedMemoryIds: readonly string[];
    readonly remainingTruncatedReferenceCount: number;
    readonly inlineComplete: boolean;
  };
  readonly nextAction: string | null;
  readonly taskAndView: {
    readonly taskId: string;
    readonly viewIdentity: string;
    readonly verificationStatus: CurrentStateView["verificationStatus"];
    readonly relevantMemoryIds: readonly string[];
  };
  readonly projection: {
    readonly authoritativeReferenceCount: number;
    readonly selectedReferenceCount: number;
    readonly omittedReferenceCount: number;
    readonly authoritative: boolean;
  };
  readonly recovery: {
    readonly taskId: string;
    readonly currentStateVersion: number | null;
    readonly checkpointReference: string | null;
  };
}

export interface BossSessionResult {
  readonly decision: BossSessionDecision;
  readonly triggers: readonly string[];
  readonly context: BossRecoveryContext | null;
  readonly reason?: string;
}

const maxItems = 16;
const maxGroupLength = 2048;
const maxContextLength = 8192;

function boundedText(value: string | null): boolean {
  return value === null || (value.length > 0 && value.length <= 256 && value.trim() === value && !containsSecretShapedValue(value));
}

function boundedList(values: readonly string[]): boolean {
  return values.length <= maxItems && values.every((value) => value !== null && boundedText(value)) && JSON.stringify(values).length <= maxGroupLength;
}

function projectLimitations(values: readonly string[], memoryIds: readonly string[]): { inline: { text: string; memoryId: string }[]; omitted: string[] } | null {
  if (values.length !== memoryIds.length) return null;
  const inline: { text: string; memoryId: string }[] = [];
  const omitted: string[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];
    const memoryId = memoryIds[index];
    if (typeof raw !== "string" || typeof memoryId !== "string" || !boundedText(memoryId) || /[\u0000-\u001f\u007f]/u.test(raw)) return null;
    // A P2 UTF-16 slice can end between surrogate halves; omit that display item and retain its recovery ID.
    if (Buffer.from(raw, "utf8").toString("utf8") !== raw) { omitted.push(memoryId); continue; }
    // P2 may truncate a valid fact at 256 characters, leaving a harmless space at the display boundary.
    const displayed = raw.replace(/\p{Zs}+$/u, "");
    if (!boundedText(displayed) || displayed.length === 0) return null;
    const candidate = [...inline.map((item) => item.text), displayed];
    if (candidate.length <= maxItems && Buffer.byteLength(JSON.stringify(candidate), "utf8") <= maxGroupLength) inline.push({ text: displayed, memoryId });
    else omitted.push(memoryId);
  }
  return { inline, omitted };
}

export function evaluateBossSignals(signals: BossSessionSignals = {}, policy: BossSessionPolicy = defaultBossSessionPolicy): { readonly decision: BossSessionDecision; readonly triggers: readonly string[] } {
  if (!Number.isSafeInteger(policy.acceptedTicketThreshold) || policy.acceptedTicketThreshold < 1) throw new Error("Boss session accepted-ticket threshold must be positive");
  const triggers: string[] = [];
  if (signals.explicitRollover) triggers.push("explicit-rollover");
  if (signals.milestone) triggers.push("milestone");
  if (signals.phaseTransition) triggers.push("phase-transition");
  if (signals.acceptedTicketCount !== undefined && signals.acceptedTicketCount >= policy.acceptedTicketThreshold) triggers.push("accepted-ticket-threshold");
  return { decision: triggers.length === 0 ? "CONTINUE_CURRENT_BOSS" : "ROLLOVER_RECOMMENDED", triggers };
}

export function deriveBossRecovery(
  project: string,
  state: TaskState,
  rebuilt: CurationPipelineRebuild,
  mode: BossSessionMode,
  signals: BossSessionSignals = {},
  policy: BossSessionPolicy = defaultBossSessionPolicy,
): BossSessionResult {
  const evaluation = evaluateBossSignals(signals, policy);
  const blocked = (reason: string): BossSessionResult => ({ decision: "BLOCKED", triggers: evaluation.triggers, context: null, reason });
  const view = rebuilt.currentView;
  if (!boundedText(project) || project.length === 0) return blocked("Canonical project identity is unavailable or unsafe");
  if (rebuilt.projectTaskId !== state.taskId || view === null || view.identity !== state.taskId || view.verificationStatus !== "verified" || !rebuilt.viewFresh || rebuilt.status === "blocked") return blocked("Fresh task-scoped authoritative current state is unavailable");
  if (mode === "prepare" && rebuilt.reason !== undefined) return blocked("Canonical checkpoint metadata is stale or unavailable for Boss rollover");
  if (state.stage === "close") return blocked("Canonical task is closed");
  if (state.approvalState === "pending" || state.approvalState === "rejected" || ["pending", "acknowledged", "active", "rejected"].includes(state.handoffState) || state.criticalUnsavedContext.length > 0) return blocked("Durable task has pending approval, handoff, or unsaved critical context");
  if (!boundedText(view.phase) || !boundedText(view.nextAction) || !boundedList(view.milestones) || !boundedList(view.currentWork) || !boundedList(view.confirmedDecisions) || !boundedList(view.blockers)) return blocked("Canonical current state exceeds the bounded Boss context");
  const verifiedCheckpoint = rebuilt.reason === undefined ? rebuilt.checkpoint : null;
  const version = verifiedCheckpoint?.currentViewVersion ?? null;
  if (version !== null && (!Number.isSafeInteger(version) || version < 0)) return blocked("Canonical current-state version is invalid");
  const beliefs = rebuilt.records.map((record) => parseTaskBelief(record, state.taskId)).filter((belief) => belief !== null);
  const limitationBeliefs = beliefs.filter((belief) => belief.critical && (belief.topicLabel === "workflow/process" || belief.topicLabel === "other/transient"))
    .sort((left, right) => left.record.sequence - right.record.sequence || left.record.memoryId.localeCompare(right.record.memoryId));
  if (!Array.isArray(view.limitations) || !Array.isArray(view.relevantMemoryIds) || view.limitations.length !== limitationBeliefs.length
    || view.limitations.some((value, index) => value !== limitationBeliefs[index]?.fact.slice(0, 256))
    || new Set(view.relevantMemoryIds).size !== view.relevantMemoryIds.length
    || limitationBeliefs.some((belief) => Buffer.from(belief.fact, "utf8").toString("utf8") !== belief.fact)
    || limitationBeliefs.some((belief) => !view.relevantMemoryIds.includes(belief.record.memoryId))) return blocked("Canonical limitations cannot be traced to task-scoped authoritative records");
  const limitations = projectLimitations(view.limitations, limitationBeliefs.map((belief) => belief.record.memoryId));
  if (limitations === null) return blocked("Canonical limitations cannot be safely represented for Boss startup");
  const truncatedLimitationIds = limitationBeliefs.filter((belief) => belief.fact.length > 256).map((belief) => belief.record.memoryId);
  const anchorIds = beliefs.filter((belief) =>
    (view.nextAction !== null && belief.fact.includes(view.nextAction))
    || view.blockers.includes(belief.fact.slice(0, 256)),
  ).map((belief) => belief.record.memoryId);
  if (mode === "prepare" && new Set(anchorIds).size > maxItems) return blocked("Canonical nextAction and blocker references exceed the bounded Boss context");
  const selectedIds = mode === "startup"
    ? [...view.relevantMemoryIds]
    : [...new Set([...anchorIds, ...view.relevantMemoryIds])].slice(0, maxItems);
  if (selectedIds.some((id) => !boundedText(id)) || (mode === "prepare" && !boundedList(selectedIds))) return blocked("Canonical current-state references exceed the bounded Boss context");
  const checkpointReference = verifiedCheckpoint?.checkpointId ?? null;
  const makeContext = (): BossRecoveryContext => ({
    project,
    taskId: state.taskId,
    phase: view.phase,
    currentStateVersion: version,
    checkpointReference,
    accepted: { milestones: view.milestones, currentWork: view.currentWork, confirmedDecisions: view.confirmedDecisions },
    blockers: view.blockers,
    limitations: limitations.inline.map((item) => item.text),
    limitationsPresentation: {
      totalCount: view.limitations.length,
      inlineCount: limitations.inline.length,
      omittedCount: limitations.omitted.length,
      omittedMemoryIds: limitations.omitted.slice(0, maxItems),
      remainingOmittedReferenceCount: Math.max(0, limitations.omitted.length - maxItems),
      truncatedCount: truncatedLimitationIds.length,
      truncatedMemoryIds: truncatedLimitationIds.slice(0, maxItems),
      remainingTruncatedReferenceCount: Math.max(0, truncatedLimitationIds.length - maxItems),
      inlineComplete: limitations.omitted.length === 0 && truncatedLimitationIds.length === 0,
    },
    nextAction: view.nextAction,
    taskAndView: { taskId: state.taskId, viewIdentity: view.identity, verificationStatus: view.verificationStatus, relevantMemoryIds: selectedIds },
    projection: { authoritativeReferenceCount: view.relevantMemoryIds.length, selectedReferenceCount: selectedIds.length, omittedReferenceCount: view.relevantMemoryIds.length - selectedIds.length, authoritative: mode === "startup" },
    recovery: { taskId: state.taskId, currentStateVersion: version, checkpointReference },
  });
  let context = makeContext();
  while (Buffer.byteLength(JSON.stringify(context), "utf8") > maxContextLength && limitations.inline.length > 0) {
    const removed = limitations.inline.pop();
    if (removed === undefined) break;
    limitations.omitted.push(removed.memoryId);
    context = makeContext();
  }
  if (Buffer.byteLength(JSON.stringify(context), "utf8") > maxContextLength) return blocked("Canonical current state exceeds the bounded Boss context");
  return { decision: mode === "prepare" && signals.explicitRollover ? "ROLLOVER_PREPARED" : mode === "prepare" ? evaluation.decision : "CONTINUE_CURRENT_BOSS", triggers: evaluation.triggers, context };
}
