import { createHash } from "node:crypto";
import { z } from "zod";
import { InvalidHandoffError, InvalidTaskStateError } from "../domain/errors.js";
import { redactSensitiveText } from "../adapters/command-runner.js";
import { isSafeManifestId } from "../domain/manifest-id.js";
import type { DebugSession, DurableContextManifest, Environment, RecoveryPoint, TaskState, VerificationEvidence } from "../domain/types.js";

export interface HandoffEnvelope {
  readonly schemaVersion: 1;
  readonly handoffId: string;
  readonly taskId: string;
  readonly sourceEnvironment: Environment;
  readonly targetEnvironment: Environment;
  readonly stage: TaskState["stage"];
  readonly role: TaskState["role"];
  readonly taskState: TaskState;
  readonly capabilitySnapshot: Readonly<Record<Environment, readonly string[]>>;
  readonly durableContextManifest: DurableContextManifest | null;
  readonly unsavedContext: readonly string[];
  readonly redactions: readonly string[];
  readonly integrityHash: string;
}

export interface CreateHandoffEnvelopeInput {
  readonly handoffId: string;
  readonly state: TaskState;
  readonly targetEnvironment: Environment;
}

const secretNamePattern = /(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?|credential|cookie|password|private[_-]?key|secret|session[_-]?token)/i;
const secretAssignmentPattern = /(\b(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?|credential|cookie|password|private[_-]?key|secret|session[_-]?token|token)\b\s*[:=]\s*)(?:Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const bearerTokenPattern = /(\bauthorization\s*:\s*bearer\s+)(?:"[^"]*"|'[^']*'|\S+)/gi;
const stageSchema = z.enum(["bootstrap", "route", "plan", "execute", "inspect", "verify", "debug", "recover", "handoff", "close"]);
const environmentSchema = z.enum(["chat", "work", "codex"]);
const roleSchema = z.enum(["analyst", "planner", "implementer", "evidence-collector", "reviewer", "debugger", "recovery-operator"]);
const debugSessionSchema = z.object({ phase: z.enum(["reproduce", "capture", "isolate", "hypothesize", "change", "reverify", "regress", "stop"]), originalFailure: z.string().min(1), hypothesis: z.string().min(1).nullable(), preservedRecoveryPointId: z.string().min(1) }).strict();
const stringRecordSchema = z.record(z.string(), z.string());
const safeManifestIdSchema = z.string().refine(isSafeManifestId, "must be a UUID or manifest-UUID");
const manifestSchema = z.object({ manifestId: safeManifestIdSchema, taskId: z.string().min(1), stage: stageSchema, environment: environmentSchema, role: roleSchema, durablePaths: z.array(z.string()), hashes: stringRecordSchema, recoveryPointId: z.string().min(1).nullable(), recordedAt: z.string().datetime() }).strict();
const recoveryPointSchema = z.object({ recoveryPointId: z.string().min(1), taskId: z.string().min(1), stage: stageSchema, environment: environmentSchema, role: roleSchema, durablePaths: z.array(z.string()), hashes: stringRecordSchema, restorationInstructions: z.string(), createdAt: z.string().datetime(), snapshotManifestId: safeManifestIdSchema.optional() }).strict();
const routingDecisionSchema = z.object({ stage: stageSchema, requestedStage: stageSchema.optional(), environment: environmentSchema, role: roleSchema, selectedModel: z.string(), selectedCapabilities: z.array(z.string()), reason: z.string(), overrideSource: z.enum(["default", "user"]) }).strict();
const evidenceSchema = z.object({ evidenceId: z.string().min(1), stage: stageSchema, environment: environmentSchema, role: roleSchema, selectedModel: z.string(), command: z.string(), observedOutput: z.string(), exitCode: z.number().int().nullable(), interpretation: z.string(), passed: z.boolean(), recoveryPointId: z.string().min(1).nullable(), recordedAt: z.string().datetime() }).strict();
const recoverySnapshotSchema = z.object({ head: z.string(), branch: z.string(), workspacePath: z.string(), status: z.string(), binaryPatch: z.string(), stateManifest: manifestSchema, verificationResults: z.array(evidenceSchema), durableArtifacts: stringRecordSchema }).strict();
const rollbackAuditSchema = z.object({ archiveId: z.string().min(1), patchDigest: z.string().regex(/^[a-f0-9]{64}$/), actions: z.array(z.object({ command: z.string().min(1), arguments: z.array(z.string()), stdout: z.string(), stderr: z.string(), exitCode: z.number().int().nullable() }).strict()), verification: z.object({ passed: z.boolean(), observedOutput: z.string(), reason: z.string() }).strict(), recordedAt: z.string().datetime() }).strict();
const taskStateSchema = z.object({ taskId: z.string().min(1), goal: z.string().min(1), constraints: z.array(z.string()), environment: environmentSchema, stage: stageSchema, role: roleSchema, routingDecision: routingDecisionSchema.nullable(), selectedCapabilities: z.array(z.string()), contextManifest: z.array(z.string()), handoffState: z.enum(["none", "pending", "acknowledged", "active", "completed", "rejected"]), verificationEvidence: z.array(evidenceSchema), verificationHistory: z.array(evidenceSchema).optional(), recoveryPoint: recoveryPointSchema.nullable(), recoverySnapshot: recoverySnapshotSchema.nullable().optional(), rollbackAudit: rollbackAuditSchema.nullable().optional(), approvalState: z.enum(["not-required", "pending", "approved", "rejected"]), criticalUnsavedContext: z.array(z.string()), durableContext: manifestSchema.nullable(), debugSession: debugSessionSchema.nullable().optional() }).strict();
export const handoffEnvelopeSchema = z.object({ schemaVersion: z.literal(1), handoffId: z.string().regex(/^handoff-[A-Za-z0-9._-]+-[1-9][0-9]*$/), taskId: z.string().min(1), sourceEnvironment: environmentSchema, targetEnvironment: environmentSchema, stage: stageSchema, role: roleSchema, taskState: taskStateSchema, capabilitySnapshot: z.object({ chat: z.array(z.string()), work: z.array(z.string()), codex: z.array(z.string()) }).strict(), durableContextManifest: manifestSchema.nullable(), unsavedContext: z.array(z.string()), redactions: z.array(z.string()), integrityHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const capabilitySnapshot: Readonly<Record<Environment, readonly string[]>> = { chat: ["approval", "status"], work: ["durable-context"], codex: ["local-execution", "codex-evidence"] };

function issueReason(result: z.ZodSafeParseError<object>): string {
  const issue = result.error.issues[0];
  return issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
}

function redactString(value: string, path: string, redactions: string[]): string {
  const redacted = redactSensitiveText(value).replace(bearerTokenPattern, "$1[REDACTED]").replace(secretAssignmentPattern, "$1[REDACTED]");
  if (redacted !== value) redactions.push(path);
  return redacted;
}

function copyStringArray(values: readonly string[], path: string, redactions: string[]): readonly string[] {
  return values.map((value, index) => redactString(value, `${path}[${index}]`, redactions));
}

function copyStringRecord(values: Readonly<Record<string, string>>, path: string, redactions: string[]): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [redactString(key, `${path}.${key}.key`, redactions), secretNamePattern.test(key) ? (redactions.push(`${path}.${key}`), "[REDACTED]") : redactString(value, `${path}.${key}`, redactions)]));
}

function copyManifest(manifest: DurableContextManifest | null, path: string, redactions: string[]): DurableContextManifest | null {
  if (manifest === null) return null;
  return { manifestId: redactString(manifest.manifestId, `${path}.manifestId`, redactions), taskId: redactString(manifest.taskId, `${path}.taskId`, redactions), stage: manifest.stage, environment: manifest.environment, role: manifest.role, durablePaths: copyStringArray(manifest.durablePaths, `${path}.durablePaths`, redactions), hashes: copyStringRecord(manifest.hashes, `${path}.hashes`, redactions), recoveryPointId: manifest.recoveryPointId === null ? null : redactString(manifest.recoveryPointId, `${path}.recoveryPointId`, redactions), recordedAt: redactString(manifest.recordedAt, `${path}.recordedAt`, redactions) };
}

function copyRecoveryPoint(value: RecoveryPoint | null, path: string, redactions: string[]): RecoveryPoint | null {
  if (value === null) return null;
  return { recoveryPointId: redactString(value.recoveryPointId, `${path}.recoveryPointId`, redactions), taskId: redactString(value.taskId, `${path}.taskId`, redactions), stage: value.stage, environment: value.environment, role: value.role, durablePaths: copyStringArray(value.durablePaths, `${path}.durablePaths`, redactions), hashes: copyStringRecord(value.hashes, `${path}.hashes`, redactions), restorationInstructions: redactString(value.restorationInstructions, `${path}.restorationInstructions`, redactions), createdAt: redactString(value.createdAt, `${path}.createdAt`, redactions), ...(value.snapshotManifestId === undefined ? {} : { snapshotManifestId: redactString(value.snapshotManifestId, `${path}.snapshotManifestId`, redactions) }) };
}

function copyEvidence(value: VerificationEvidence, path: string, redactions: string[]): VerificationEvidence {
  return { evidenceId: redactString(value.evidenceId, `${path}.evidenceId`, redactions), stage: value.stage, environment: value.environment, role: value.role, selectedModel: redactString(value.selectedModel, `${path}.selectedModel`, redactions), command: redactString(value.command, `${path}.command`, redactions), observedOutput: redactString(value.observedOutput, `${path}.observedOutput`, redactions), exitCode: value.exitCode, interpretation: redactString(value.interpretation, `${path}.interpretation`, redactions), passed: value.passed, recoveryPointId: value.recoveryPointId === null ? null : redactString(value.recoveryPointId, `${path}.recoveryPointId`, redactions), recordedAt: redactString(value.recordedAt, `${path}.recordedAt`, redactions) };
}

function copyDebugSession(value: DebugSession | null | undefined, path: string, redactions: string[]): DebugSession | null | undefined {
  if (value === undefined || value === null) return value;
  return {
    phase: value.phase,
    originalFailure: redactString(value.originalFailure, `${path}.originalFailure`, redactions),
    hypothesis: value.hypothesis === null ? null : redactString(value.hypothesis, `${path}.hypothesis`, redactions),
    preservedRecoveryPointId: redactString(value.preservedRecoveryPointId, `${path}.preservedRecoveryPointId`, redactions),
  };
}

function copyPortableState(state: TaskState, redactions: string[]): TaskState {
  return { taskId: redactString(state.taskId, "taskState.taskId", redactions), goal: redactString(state.goal, "taskState.goal", redactions), constraints: copyStringArray(state.constraints, "taskState.constraints", redactions), environment: state.environment, stage: state.stage, role: state.role, routingDecision: state.routingDecision === null ? null : { stage: state.routingDecision.stage, ...(state.routingDecision.requestedStage === undefined ? {} : { requestedStage: state.routingDecision.requestedStage }), environment: state.routingDecision.environment, role: state.routingDecision.role, selectedModel: redactString(state.routingDecision.selectedModel, "taskState.routingDecision.selectedModel", redactions), selectedCapabilities: copyStringArray(state.routingDecision.selectedCapabilities, "taskState.routingDecision.selectedCapabilities", redactions), reason: redactString(state.routingDecision.reason, "taskState.routingDecision.reason", redactions), overrideSource: state.routingDecision.overrideSource }, selectedCapabilities: copyStringArray(state.selectedCapabilities, "taskState.selectedCapabilities", redactions), contextManifest: copyStringArray(state.contextManifest, "taskState.contextManifest", redactions), handoffState: "pending", verificationEvidence: state.verificationEvidence.map((value, index) => copyEvidence(value, `taskState.verificationEvidence[${index}]`, redactions)), ...(state.verificationHistory === undefined ? {} : { verificationHistory: state.verificationHistory.map((value, index) => copyEvidence(value, `taskState.verificationHistory[${index}]`, redactions)) }), recoveryPoint: copyRecoveryPoint(state.recoveryPoint, "taskState.recoveryPoint", redactions), approvalState: state.approvalState, criticalUnsavedContext: copyStringArray(state.criticalUnsavedContext, "taskState.criticalUnsavedContext", redactions), durableContext: copyManifest(state.durableContext, "taskState.durableContext", redactions), ...(state.debugSession === undefined ? {} : { debugSession: copyDebugSession(state.debugSession, "taskState.debugSession", redactions) }) };
}

function envelopeContent(envelope: Omit<HandoffEnvelope, "integrityHash">): string { return JSON.stringify(envelope); }

function integrityHash(envelope: Omit<HandoffEnvelope, "integrityHash">): string { return createHash("sha256").update(envelopeContent(envelope), "utf8").digest("hex"); }

function assertNestedIdentity(envelope: HandoffEnvelope): void {
  const state = envelope.taskState;
  const matches = (taskId: string, stage: TaskState["stage"], environment: Environment, role: TaskState["role"]): boolean => taskId === envelope.taskId && stage === envelope.stage && environment === envelope.sourceEnvironment && role === envelope.role;
  if (state.routingDecision !== null && !matches(envelope.taskId, state.routingDecision.stage, state.routingDecision.environment, state.routingDecision.role)) throw new InvalidHandoffError(`Invalid handoff envelope: routing decision identity mismatch for ${envelope.handoffId}`);
  if (state.durableContext !== null && !matches(state.durableContext.taskId, state.durableContext.stage, state.durableContext.environment, state.durableContext.role)) throw new InvalidHandoffError(`Invalid handoff envelope: durable context identity mismatch for ${envelope.handoffId}`);
  if (state.recoveryPoint !== null && state.recoveryPoint.taskId !== envelope.taskId) throw new InvalidHandoffError(`Invalid handoff envelope: recovery point task identity mismatch for ${envelope.handoffId}`);
  if (state.recoveryPoint !== null && state.verificationEvidence.some((evidence) => evidence.recoveryPointId !== null && evidence.recoveryPointId !== state.recoveryPoint?.recoveryPointId)) throw new InvalidHandoffError(`Invalid handoff envelope: verification evidence recovery linkage mismatch for ${envelope.handoffId}`);
}

function cloneEnvelope(envelope: HandoffEnvelope): HandoffEnvelope {
  const redactions: string[] = [];
  return { ...envelope, taskState: copyPortableState(envelope.taskState, redactions), capabilitySnapshot: { chat: [...envelope.capabilitySnapshot.chat], work: [...envelope.capabilitySnapshot.work], codex: [...envelope.capabilitySnapshot.codex] }, durableContextManifest: copyManifest(envelope.durableContextManifest, "durableContextManifest", redactions), unsavedContext: copyStringArray(envelope.unsavedContext, "unsavedContext", redactions), redactions: [...envelope.redactions] };
}

export function validateHandoffCreateInput(value: CreateHandoffEnvelopeInput | object | null): CreateHandoffEnvelopeInput {
  const inputSchema = z.object({ handoffId: z.string().regex(/^handoff-[A-Za-z0-9._-]+-[1-9][0-9]*$/), state: taskStateSchema, targetEnvironment: environmentSchema }).strict();
  const result = inputSchema.safeParse(value);
  if (!result.success) throw new InvalidTaskStateError(`Invalid handoff create input: ${issueReason(result)}`);
  return result.data;
}

export function createHandoffEnvelope(input: CreateHandoffEnvelopeInput): HandoffEnvelope {
  const validatedInput = validateHandoffCreateInput(input);
  if (validatedInput.state.handoffState !== "none") throw new InvalidTaskStateError(`Cannot create a handoff for task ${validatedInput.state.taskId} from handoff state ${validatedInput.state.handoffState}`);
  const redactions: string[] = [];
  const portableState = copyPortableState(validatedInput.state, redactions);
  const candidate: Omit<HandoffEnvelope, "integrityHash"> = { schemaVersion: 1, handoffId: validatedInput.handoffId, taskId: portableState.taskId, sourceEnvironment: portableState.environment, targetEnvironment: validatedInput.targetEnvironment, stage: portableState.stage, role: portableState.role, taskState: portableState, capabilitySnapshot: { chat: [...capabilitySnapshot.chat], work: [...capabilitySnapshot.work], codex: [...capabilitySnapshot.codex] }, durableContextManifest: copyManifest(portableState.durableContext, "durableContextManifest", redactions), unsavedContext: [...portableState.criticalUnsavedContext], redactions };
  return parseHandoffEnvelope({ ...candidate, integrityHash: integrityHash(candidate) });
}

export function parseHandoffEnvelope(value: HandoffEnvelope): HandoffEnvelope {
  const result = handoffEnvelopeSchema.safeParse(value);
  if (!result.success) throw new InvalidHandoffError(`Invalid handoff envelope: ${issueReason(result)}`);
  const envelope = result.data;
  const { integrityHash: suppliedHash, ...content } = envelope;
  const expectedHash = integrityHash(content);
  if (suppliedHash !== expectedHash) throw new InvalidHandoffError(`Invalid handoff envelope: integrity hash mismatch for ${envelope.handoffId}`);
  if (envelope.taskState.taskId !== envelope.taskId || envelope.taskState.environment !== envelope.sourceEnvironment || envelope.taskState.stage !== envelope.stage || envelope.taskState.role !== envelope.role || envelope.taskState.handoffState !== "pending" || JSON.stringify(envelope.taskState.durableContext) !== JSON.stringify(envelope.durableContextManifest) || JSON.stringify(envelope.taskState.criticalUnsavedContext) !== JSON.stringify(envelope.unsavedContext)) throw new InvalidHandoffError(`Invalid handoff envelope: task state does not match handoff identity for ${envelope.handoffId}`);
  assertNestedIdentity(envelope);
  return cloneEnvelope(envelope);
}

export function handoffEnvelopeSignature(envelope: HandoffEnvelope): string {
  const { integrityHash: ignoredIntegrityHash, ...content } = parseHandoffEnvelope(envelope);
  return envelopeContent(content);
}
