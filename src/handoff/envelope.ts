import { z } from "zod";
import { InvalidHandoffError, InvalidTaskStateError } from "../domain/errors.js";
import type { DurableContextManifest, Environment, TaskState } from "../domain/types.js";

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
}

export interface CreateHandoffEnvelopeInput {
  readonly handoffId: string;
  readonly state: TaskState;
  readonly targetEnvironment: Environment;
}

const secretValuePattern = /((?:api[_-]?(?:key|token)|access[_-]?token|authorization|credential|cookie|password|private[_-]?key|secret|session[_-]?token)\s*[:=]\s*)[^\s,;]+/gi;

const stageSchema = z.enum(["bootstrap", "route", "plan", "execute", "inspect", "verify", "debug", "recover", "handoff", "close"]);
const environmentSchema = z.enum(["chat", "work", "codex"]);
const roleSchema = z.enum(["analyst", "planner", "implementer", "evidence-collector", "reviewer", "debugger", "recovery-operator"]);
const stringRecordSchema = z.record(z.string(), z.string());
const manifestSchema = z.object({
  manifestId: z.string().min(1),
  taskId: z.string().min(1),
  stage: stageSchema,
  environment: environmentSchema,
  role: roleSchema,
  durablePaths: z.array(z.string()),
  hashes: stringRecordSchema,
  recoveryPointId: z.string().min(1).nullable(),
  recordedAt: z.string().datetime(),
}).strict();
const recoveryPointSchema = z.object({
  recoveryPointId: z.string().min(1),
  taskId: z.string().min(1),
  stage: stageSchema,
  environment: environmentSchema,
  role: roleSchema,
  durablePaths: z.array(z.string()),
  hashes: stringRecordSchema,
  restorationInstructions: z.string(),
  createdAt: z.string().datetime(),
}).strict();
const routingDecisionSchema = z.object({
  stage: stageSchema,
  environment: environmentSchema,
  role: roleSchema,
  selectedModel: z.string(),
  selectedCapabilities: z.array(z.string()),
  reason: z.string(),
  overrideSource: z.enum(["default", "user"]),
}).strict();
const evidenceSchema = z.object({
  evidenceId: z.string().min(1),
  stage: stageSchema,
  environment: environmentSchema,
  role: roleSchema,
  selectedModel: z.string(),
  command: z.string(),
  observedOutput: z.string(),
  exitCode: z.number().int().nullable(),
  interpretation: z.string(),
  passed: z.boolean(),
  recoveryPointId: z.string().min(1).nullable(),
  recordedAt: z.string().datetime(),
}).strict();
const taskStateSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string().min(1),
  constraints: z.array(z.string()),
  environment: environmentSchema,
  stage: stageSchema,
  role: roleSchema,
  routingDecision: routingDecisionSchema.nullable(),
  selectedCapabilities: z.array(z.string()),
  contextManifest: z.array(z.string()),
  handoffState: z.enum(["none", "pending", "acknowledged", "active", "completed", "rejected"]),
  verificationEvidence: z.array(evidenceSchema),
  recoveryPoint: recoveryPointSchema.nullable(),
  approvalState: z.enum(["not-required", "pending", "approved", "rejected"]),
  criticalUnsavedContext: z.array(z.string()),
  durableContext: manifestSchema.nullable(),
}).strict();
const capabilitySnapshotSchema = z.object({
  chat: z.array(z.string()),
  work: z.array(z.string()),
  codex: z.array(z.string()),
}).strict();
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  handoffId: z.string().regex(/^handoff-[A-Za-z0-9._-]+-[1-9][0-9]*$/),
  taskId: z.string().min(1),
  sourceEnvironment: environmentSchema,
  targetEnvironment: environmentSchema,
  stage: stageSchema,
  role: roleSchema,
  taskState: taskStateSchema,
  capabilitySnapshot: capabilitySnapshotSchema,
  durableContextManifest: manifestSchema.nullable(),
  unsavedContext: z.array(z.string()),
  redactions: z.array(z.string()),
}).strict();

const capabilitySnapshot: Readonly<Record<Environment, readonly string[]>> = {
  chat: ["approval", "status"],
  work: ["durable-context"],
  codex: ["local-execution", "codex-evidence"],
};

function redactString(value: string, path: string, redactions: string[]): string {
  const redacted = value.replace(secretValuePattern, "$1[REDACTED]");
  if (redacted !== value) {
    redactions.push(path);
  }
  return redacted;
}

function copyStringArray(values: readonly string[], path: string, redactions: string[]): readonly string[] {
  return values.map((value, index) => redactString(value, `${path}[${index}]`, redactions));
}

function copyStringRecord(values: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value]));
}

function copyManifest(manifest: DurableContextManifest | null): DurableContextManifest | null {
  if (manifest === null) {
    return null;
  }
  return { ...manifest, durablePaths: [...manifest.durablePaths], hashes: copyStringRecord(manifest.hashes) };
}

function copyPortableState(state: TaskState, redactions: string[]): TaskState {
  return {
    taskId: redactString(state.taskId, "taskState.taskId", redactions),
    goal: redactString(state.goal, "taskState.goal", redactions),
    constraints: copyStringArray(state.constraints, "taskState.constraints", redactions),
    environment: state.environment,
    stage: state.stage,
    role: state.role,
    routingDecision: state.routingDecision === null ? null : {
      ...state.routingDecision,
      selectedModel: redactString(state.routingDecision.selectedModel, "taskState.routingDecision.selectedModel", redactions),
      selectedCapabilities: copyStringArray(state.routingDecision.selectedCapabilities, "taskState.routingDecision.selectedCapabilities", redactions),
      reason: redactString(state.routingDecision.reason, "taskState.routingDecision.reason", redactions),
    },
    selectedCapabilities: copyStringArray(state.selectedCapabilities, "taskState.selectedCapabilities", redactions),
    contextManifest: copyStringArray(state.contextManifest, "taskState.contextManifest", redactions),
    handoffState: "pending",
    verificationEvidence: state.verificationEvidence.map((evidence, index) => ({
      ...evidence,
      evidenceId: redactString(evidence.evidenceId, `taskState.verificationEvidence[${index}].evidenceId`, redactions),
      selectedModel: redactString(evidence.selectedModel, `taskState.verificationEvidence[${index}].selectedModel`, redactions),
      command: redactString(evidence.command, `taskState.verificationEvidence[${index}].command`, redactions),
      observedOutput: redactString(evidence.observedOutput, `taskState.verificationEvidence[${index}].observedOutput`, redactions),
      interpretation: redactString(evidence.interpretation, `taskState.verificationEvidence[${index}].interpretation`, redactions),
    })),
    recoveryPoint: state.recoveryPoint === null ? null : {
      ...state.recoveryPoint,
      durablePaths: [...state.recoveryPoint.durablePaths],
      hashes: copyStringRecord(state.recoveryPoint.hashes),
      restorationInstructions: redactString(state.recoveryPoint.restorationInstructions, "taskState.recoveryPoint.restorationInstructions", redactions),
    },
    approvalState: state.approvalState,
    criticalUnsavedContext: copyStringArray(state.criticalUnsavedContext, "taskState.criticalUnsavedContext", redactions),
    durableContext: copyManifest(state.durableContext),
  };
}

function cloneEnvelope(envelope: HandoffEnvelope): HandoffEnvelope {
  return {
    schemaVersion: 1,
    handoffId: envelope.handoffId,
    taskId: envelope.taskId,
    sourceEnvironment: envelope.sourceEnvironment,
    targetEnvironment: envelope.targetEnvironment,
    stage: envelope.stage,
    role: envelope.role,
    taskState: copyPortableState(envelope.taskState, []),
    capabilitySnapshot: {
      chat: [...envelope.capabilitySnapshot.chat],
      work: [...envelope.capabilitySnapshot.work],
      codex: [...envelope.capabilitySnapshot.codex],
    },
    durableContextManifest: copyManifest(envelope.durableContextManifest),
    unsavedContext: [...envelope.unsavedContext],
    redactions: [...envelope.redactions],
  };
}

function parseTaskState(state: TaskState): TaskState {
  const result = taskStateSchema.safeParse(state);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new InvalidTaskStateError(`Invalid handoff task state: ${reason}`);
  }
  return result.data;
}

export function createHandoffEnvelope(input: CreateHandoffEnvelopeInput): HandoffEnvelope {
  const redactions: string[] = [];
  const portableState = copyPortableState(input.state, redactions);
  const validatedState = parseTaskState(portableState);
  if (input.state.handoffState !== "none") {
    throw new InvalidTaskStateError(`Cannot create a handoff for task ${validatedState.taskId} from handoff state ${input.state.handoffState}`);
  }
  const candidate: HandoffEnvelope = {
    schemaVersion: 1,
    handoffId: input.handoffId,
    taskId: validatedState.taskId,
    sourceEnvironment: validatedState.environment,
    targetEnvironment: input.targetEnvironment,
    stage: validatedState.stage,
    role: validatedState.role,
    taskState: validatedState,
    capabilitySnapshot: { chat: [...capabilitySnapshot.chat], work: [...capabilitySnapshot.work], codex: [...capabilitySnapshot.codex] },
    durableContextManifest: copyManifest(validatedState.durableContext),
    unsavedContext: [...validatedState.criticalUnsavedContext],
    redactions,
  };
  return parseHandoffEnvelope(candidate);
}

export function parseHandoffEnvelope(value: HandoffEnvelope): HandoffEnvelope {
  const result = envelopeSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new InvalidHandoffError(`Invalid handoff envelope: ${reason}`);
  }
  const envelope = result.data;
  if (
    envelope.taskState.taskId !== envelope.taskId ||
    envelope.taskState.environment !== envelope.sourceEnvironment ||
    envelope.taskState.stage !== envelope.stage ||
    envelope.taskState.role !== envelope.role ||
    envelope.taskState.handoffState !== "pending" ||
    JSON.stringify(envelope.taskState.durableContext) !== JSON.stringify(envelope.durableContextManifest) ||
    JSON.stringify(envelope.taskState.criticalUnsavedContext) !== JSON.stringify(envelope.unsavedContext)
  ) {
    throw new InvalidHandoffError(`Invalid handoff envelope: task state does not match handoff identity for ${envelope.handoffId}`);
  }
  return cloneEnvelope(envelope);
}

export function handoffEnvelopeSignature(envelope: HandoffEnvelope): string {
  return JSON.stringify(cloneEnvelope(envelope));
}
