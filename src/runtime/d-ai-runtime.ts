import { join } from "node:path";
import { z } from "zod";
import { CommandExecutionError, redactSensitiveText } from "../adapters/command-runner.js";
import { ChatEnvironmentAdapter } from "../adapters/environments/chat-adapter.js";
import { CodexEnvironmentAdapter } from "../adapters/environments/codex-adapter.js";
import { WorkEnvironmentAdapter } from "../adapters/environments/work-adapter.js";
import { GitHubCliAdapter } from "../adapters/github.js";
import { bootstrapTask } from "../bootstrap/bootstrap-task.js";
import { closeTask } from "../close/close-service.js";
import { createDebugSession, type DebugSession } from "../debugging/debug-session.js";
import { CapabilityMismatchError, CloseBlockedError, InvalidHandoffError, InvalidTaskStateError } from "../domain/errors.js";
import { assertStageTransition } from "../domain/transitions.js";
import type { CloseVerdict, Environment, RecoveryPoint, Role, Stage, TaskState, VerificationEvidence } from "../domain/types.js";
import type { DAICommand } from "../entry/command-parser.js";
import { FileHandoffPersistence, PersistentHandoffService, type HandoffService, type HandoffStatus } from "../handoff/handoff-service.js";
import type { HandoffEnvelope } from "../handoff/envelope.js";
import type { EnvironmentCapabilities } from "../routing/environment-capabilities.js";
import { selectEnvironment, type EnvironmentRoute, type EnvironmentRouteInput } from "../routing/environment-router.js";
import { resolveModelRoute, type ModelPolicy } from "../routing/model-router.js";
import type { RoutingOverrides } from "../routing/override-parser.js";
import { discoverSkillMetadata, selectCapabilities } from "../skills/registry.js";
import { loadSelectedSkill, type LoadedSkill } from "../skills/skill-loader.js";
import type { DurableContextStore } from "../state/durable-context-store.js";
import { FileDurableContextStore } from "../state/file-durable-context-store.js";
import { evaluateHardGates, type GateEvidence, type GateResult, type HardGateInput } from "../verification/gates.js";

export interface DAIRequest {
  readonly command: DAICommand;
  readonly sourceEnvironment: Environment;
  readonly overrides: RoutingOverrides;
}

export interface DAIResponse {
  readonly taskId: string;
  readonly stage: Stage;
  readonly environment: Environment;
  readonly status: "accepted" | "blocked" | "completed";
  readonly evidence: readonly VerificationEvidence[];
  readonly message: string;
}

export interface ExternalRoutingOverrides {
  readonly model: string | null;
  readonly role: string | null;
  readonly environment: string | null;
}

export interface ExternalDAIRequest {
  readonly command: DAICommand;
  readonly sourceEnvironment: string;
  readonly overrides: ExternalRoutingOverrides;
}

export interface EnvironmentExecutionRequest {
  readonly state: TaskState;
  readonly skills: readonly LoadedSkill[];
}

export interface EnvironmentExecutionResult {
  readonly status: "completed" | "blocked" | "failed";
  readonly evidence: readonly VerificationEvidence[];
  readonly message: string;
}

export type EnvironmentExecutor = (request: EnvironmentExecutionRequest) => Promise<EnvironmentExecutionResult>;

export interface DAIEnvironmentAdapter {
  capabilities(): EnvironmentCapabilities;
  execute(request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult>;
  receive(envelope: HandoffEnvelope): Promise<void>;
  complete(handoffId: string): Promise<void>;
  status(handoffId: string): HandoffStatus;
}

type BootstrapTask = typeof bootstrapTask;
type SelectEnvironment = (input: EnvironmentRouteInput) => EnvironmentRoute;
type ResolveModelRoute = typeof resolveModelRoute;
type DiscoverSkillMetadata = typeof discoverSkillMetadata;
type SelectCapabilities = typeof selectCapabilities;
type LoadSelectedSkill = typeof loadSelectedSkill;
type EvaluateHardGates = (input: HardGateInput) => readonly GateResult[];
type CreateDebugSession = (originalFailure: string, preservedRecoveryPointId: string) => DebugSession;
type CaptureRecoveryPoint = (state: TaskState) => Promise<RecoveryPoint>;
type Recover = (state: TaskState, reason: string) => Promise<TaskState>;
export interface DAIRuntimeDependencies {
  readonly store: DurableContextStore;
  readonly workspacePath: string | null;
  readonly repositoryPath: string | null;
  readonly skillRoots: readonly string[];
  readonly modelPolicies: readonly ModelPolicy[];
  readonly adapters: Readonly<Record<Environment, DAIEnvironmentAdapter>>;
  readonly handoffService: HandoffService;
  readonly bootstrapTask: BootstrapTask;
  readonly selectEnvironment: SelectEnvironment;
  readonly resolveModelRoute: ResolveModelRoute;
  readonly discoverSkillMetadata: DiscoverSkillMetadata;
  readonly selectCapabilities: SelectCapabilities;
  readonly loadSelectedSkill: LoadSelectedSkill;
  readonly evaluateHardGates: EvaluateHardGates;
  readonly createDebugSession: CreateDebugSession;
  readonly captureRecoveryPoint: CaptureRecoveryPoint;
  readonly recover: Recover;
  readonly closeTask: (state: TaskState) => Promise<CloseVerdict>;
  readonly maximumEvidenceAgeMs: number;
  readonly now: () => Date;
}

const environmentSchema = z.enum(["chat", "work", "codex"]);
const roleSchema = z.enum(["analyst", "planner", "implementer", "evidence-collector", "reviewer", "debugger", "recovery-operator"]);
const stageSchema = z.enum(["bootstrap", "route", "plan", "execute", "inspect", "verify", "debug", "recover", "handoff", "close"]);
const commandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("intent"), text: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("continue"), taskIdOrProject: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("status") }).strict(),
  z.object({ kind: z.literal("handoff"), target: environmentSchema }).strict(),
  z.object({ kind: z.literal("close") }).strict(),
]);
const overridesSchema = z.object({
  model: z.string().trim().min(1).nullable(),
  role: roleSchema.nullable(),
  environment: environmentSchema.nullable(),
}).strict();
const requestSchema = z.object({ command: commandSchema, sourceEnvironment: environmentSchema, overrides: overridesSchema }).strict();
const evidenceSchema = z.object({
  evidenceId: z.string().trim().min(1),
  stage: stageSchema,
  environment: environmentSchema,
  role: roleSchema,
  selectedModel: z.string().trim().min(1),
  command: z.string().trim().min(1),
  observedOutput: z.string().trim().min(1),
  exitCode: z.number().int().nullable(),
  interpretation: z.string().trim().min(1),
  passed: z.boolean(),
  recoveryPointId: z.string().trim().min(1).nullable(),
  recordedAt: z.string().datetime(),
}).strict();
const executionResultSchema = z.object({
  status: z.enum(["completed", "blocked", "failed"]),
  evidence: z.array(evidenceSchema),
  message: z.string().trim().min(1),
}).strict();

const applicableExecutionGates = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "durable-context",
  "critical-unsaved-context",
] as const;

type ApplicableExecutionGate = typeof applicableExecutionGates[number];

interface ConnectorSuccess<T> {
  readonly kind: "success";
  readonly value: T;
}

interface ConnectorBlocked {
  readonly kind: "blocked";
  readonly message: string;
}

type ConnectorOutcome<T> = ConnectorSuccess<T> | ConnectorBlocked;
type ConnectorFailureMessage = (error: Error) => string | null;

function validationReason(issues: readonly z.ZodIssue[]): string {
  const issue = issues[0];
  return issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
}

function validateRequest(request: ExternalDAIRequest): DAIRequest {
  const result = requestSchema.safeParse(request);
  if (!result.success) {
    throw new InvalidTaskStateError(`Invalid D-AI request: ${validationReason(result.error.issues)}`);
  }
  return result.data;
}

function validateDependencies(dependencies: DAIRuntimeDependencies): void {
  if (dependencies.workspacePath === null && dependencies.repositoryPath === null) {
    throw new InvalidTaskStateError("D-AI runtime requires a workspace or repository identity");
  }
  if (!Array.isArray(dependencies.skillRoots) || dependencies.skillRoots.length === 0) {
    throw new InvalidTaskStateError("D-AI runtime requires at least one Skill root");
  }
  if (!Array.isArray(dependencies.modelPolicies) || dependencies.modelPolicies.length === 0) {
    throw new InvalidTaskStateError("D-AI runtime requires at least one model policy");
  }
  if (!Number.isFinite(dependencies.maximumEvidenceAgeMs) || dependencies.maximumEvidenceAgeMs < 0) {
    throw new InvalidTaskStateError("D-AI runtime maximum evidence age must be non-negative and finite");
  }
  for (const environment of environmentSchema.options) {
    const capabilityDeclaration = dependencies.adapters[environment].capabilities();
    if (capabilityDeclaration.environment !== environment) {
      throw new InvalidTaskStateError(`D-AI adapter key ${environment} does not match ${capabilityDeclaration.environment}`);
    }
  }
}

function validateExecutionResult(result: EnvironmentExecutionResult): EnvironmentExecutionResult {
  const parsed = executionResultSchema.safeParse(result);
  if (!parsed.success) {
    throw new InvalidTaskStateError(`Invalid environment execution result: ${validationReason(parsed.error.issues)}`);
  }
  return {
    ...parsed.data,
    evidence: parsed.data.evidence.map(redactEvidence),
    message: redactSensitiveText(parsed.data.message),
  };
}

function redactEvidence(evidence: VerificationEvidence): VerificationEvidence {
  return {
    ...evidence,
    evidenceId: redactSensitiveText(evidence.evidenceId),
    selectedModel: redactSensitiveText(evidence.selectedModel),
    command: redactSensitiveText(evidence.command),
    observedOutput: redactSensitiveText(evidence.observedOutput),
    interpretation: redactSensitiveText(evidence.interpretation),
    recoveryPointId: evidence.recoveryPointId === null ? null : redactSensitiveText(evidence.recoveryPointId),
  };
}

function redactStateEvidence(state: TaskState): TaskState {
  return { ...state, verificationEvidence: state.verificationEvidence.map(redactEvidence) };
}

async function persistState(store: DurableContextStore, state: TaskState): Promise<TaskState> {
  const redactedState = redactStateEvidence(state);
  const manifest = await store.save(redactedState);
  return { ...redactedState, durableContext: manifest };
}

function response(state: TaskState, status: DAIResponse["status"], message: string): DAIResponse {
  return {
    taskId: state.taskId,
    stage: state.stage,
    environment: state.environment,
    status,
    evidence: state.verificationEvidence.map(redactEvidence),
    message: redactSensitiveText(message),
  };
}

function blockedWithoutState(taskId: string, environment: Environment, message: string): DAIResponse {
  return { taskId, stage: "bootstrap", environment, status: "blocked", evidence: [], message: redactSensitiveText(message) };
}

function connectorOutcome<T>(operation: () => Promise<T>, failureMessage: ConnectorFailureMessage): Promise<ConnectorOutcome<T>> {
  return Promise.resolve().then(operation).then(
    (value): ConnectorSuccess<T> => ({ kind: "success", value }),
    (error: Error): ConnectorBlocked | Promise<never> => {
      const message = failureMessage(error);
      return message === null
        ? Promise.reject(error)
        : { kind: "blocked", message: redactSensitiveText(message) };
    },
  );
}

function executionConnectorFailure(error: Error): string | null {
  if (error instanceof CommandExecutionError) {
    const output = [error.result.stderr, error.result.stdout].find((value) => value.trim().length > 0);
    return output === undefined ? error.message : `${error.message}: ${output}`;
  }
  return error instanceof InvalidTaskStateError ? error.message : null;
}

function handoffConnectorFailure(error: Error): string | null {
  return error instanceof InvalidHandoffError || error instanceof CapabilityMismatchError || error instanceof InvalidTaskStateError
    ? error.message
    : null;
}

function closeConnectorFailure(error: Error): string | null {
  return error instanceof CloseBlockedError ? error.message : null;
}

function transitionState(state: TaskState, stage: Stage, role: Role, environment: Environment): TaskState {
  assertStageTransition(state.stage, stage);
  return {
    ...state,
    stage,
    role,
    environment,
    routingDecision: state.routingDecision === null ? null : {
      ...state.routingDecision,
      stage,
      role,
      environment,
    },
    durableContext: null,
  };
}

function preferredEnvironment(
  sourceEnvironment: Environment,
  overrides: RoutingOverrides,
  policies: readonly ModelPolicy[],
): Environment {
  if (overrides.environment !== null) return overrides.environment;
  const role: Role = overrides.role ?? "implementer";
  const policy = policies.find((candidate) =>
    candidate.stage === "execute"
    && candidate.role === role
    && (overrides.model === null || candidate.model === overrides.model),
  );
  return policy?.compatibleEnvironments[0] ?? sourceEnvironment;
}

async function routeIntent(
  state: TaskState,
  request: DAIRequest,
  dependencies: DAIRuntimeDependencies,
): Promise<{ readonly state: TaskState; readonly skills: readonly LoadedSkill[] }> {
  const candidateEnvironment = preferredEnvironment(request.sourceEnvironment, request.overrides, dependencies.modelPolicies);
  const modelDecision = dependencies.resolveModelRoute(
    "execute",
    "implementer",
    candidateEnvironment,
    dependencies.modelPolicies,
    request.overrides,
  );
  const route = dependencies.selectEnvironment({
    stage: "execute",
    requiredCapabilities: modelDecision.selectedCapabilities,
    available: environmentSchema.options.map((environment) => dependencies.adapters[environment].capabilities()),
    userEnvironmentOverride: request.overrides.environment,
  });
  const routingDecision = route.environment === modelDecision.environment
    ? modelDecision
    : dependencies.resolveModelRoute("execute", "implementer", route.environment, dependencies.modelPolicies, request.overrides);
  assertStageTransition(state.stage, "route");
  const routedState = await persistState(dependencies.store, {
    ...state,
    constraints: state.constraints.length === 0 ? ["Execute only the requested D-AI intent"] : state.constraints,
    environment: route.environment,
    stage: "route",
    role: "planner",
    routingDecision: {
      ...routingDecision,
      stage: "route",
      environment: route.environment,
      role: "planner",
    },
    selectedCapabilities: [...routingDecision.selectedCapabilities],
    durableContext: null,
  });
  const descriptors = await dependencies.discoverSkillMetadata(dependencies.skillRoots);
  const selected = dependencies.selectCapabilities(routedState.goal, "execute", route.environment, descriptors);
  const skills = await Promise.all(selected.map((descriptor) => dependencies.loadSelectedSkill(descriptor, [])));
  const contextManifest = [
    ...routedState.contextManifest,
    ...selected.map((descriptor) => `skill:${descriptor.name}:${descriptor.skillPath}`),
  ];
  const plannedState = await persistState(dependencies.store, {
    ...transitionState(routedState, "plan", "planner", route.environment),
    contextManifest,
  });
  const executionState = transitionState(plannedState, "execute", routingDecision.role, route.environment);
  return { state: await persistState(dependencies.store, executionState), skills };
}

function gateEvidence(evidence: readonly VerificationEvidence[]): readonly GateEvidence[] {
  return evidence.flatMap((verification) => {
    const gate: ApplicableExecutionGate | undefined = applicableExecutionGates.find((candidate) => verification.evidenceId === `gate:${candidate}`);
    return gate === undefined ? [] : [{ gate, verification }];
  });
}

function gateEvidenceFailure(evidence: readonly VerificationEvidence[]): string | null {
  for (const gate of applicableExecutionGates) {
    const matches = evidence.filter((verification) => verification.evidenceId === `gate:${gate}`);
    if (matches.length === 0) return `Missing evidence for ${gate} gate`;
    if (matches.length > 1) return `Ambiguous evidence for ${gate} gate`;
  }
  return null;
}

function evidenceIdentityFailure(state: TaskState, evidence: readonly VerificationEvidence[]): string | null {
  const selectedModel = state.routingDecision?.selectedModel;
  for (const verification of evidence) {
    if (verification.stage !== "verify") return `External evidence ${verification.evidenceId} is not recorded for the verify stage`;
    if (verification.environment !== state.environment) return `External evidence ${verification.evidenceId} does not match the routed environment`;
    if (verification.role !== "evidence-collector") return `External evidence ${verification.evidenceId} is not recorded by the evidence collector`;
    if (selectedModel === undefined || verification.selectedModel !== selectedModel) return `External evidence ${verification.evidenceId} does not match the selected model`;
  }
  return null;
}

function recoveryPointFailure(state: TaskState, recoveryPoint: RecoveryPoint): string | null {
  const manifest = state.durableContext;
  if (manifest === null) return "Recovery point capture requires a persisted verify manifest";
  if (
    recoveryPoint.taskId !== state.taskId
    || recoveryPoint.stage !== state.stage
    || recoveryPoint.environment !== state.environment
    || recoveryPoint.role !== state.role
  ) return "Captured recovery point identity does not match the verify state";
  if (recoveryPoint.recoveryPointId.trim().length === 0 || recoveryPoint.restorationInstructions.trim().length === 0) {
    return "Captured recovery point is incomplete";
  }
  if (
    recoveryPoint.durablePaths.length !== manifest.durablePaths.length
    || recoveryPoint.durablePaths.some((path, index) => path !== manifest.durablePaths[index] || recoveryPoint.hashes[path] !== manifest.hashes[path])
  ) return "Captured recovery point does not match the persisted verify artifacts";
  return null;
}

function failedGateReason(results: readonly GateResult[]): string | null {
  for (const requiredGate of applicableExecutionGates) {
    const matches = results.filter((result) => result.gate === requiredGate);
    if (matches.length === 0) {
      return `Missing applicable ${requiredGate} gate result`;
    }
    if (matches.length > 1) {
      return `Ambiguous applicable ${requiredGate} gate results`;
    }
    const result = matches[0];
    if (result === undefined) {
      throw new InvalidTaskStateError(`Applicable ${requiredGate} gate lookup failed`);
    }
    if (!result.passed) {
      return result.reason;
    }
  }
  return null;
}

async function enterRecovery(
  state: TaskState,
  reason: string,
  dependencies: DAIRuntimeDependencies,
): Promise<DAIResponse> {
  const redactedReason = redactSensitiveText(reason);
  const debugTransition = transitionState(state, "debug", "debugger", state.environment);
  const debugState = await persistState(dependencies.store, {
    ...debugTransition,
    routingDecision: debugTransition.routingDecision === null ? null : {
      ...debugTransition.routingDecision,
      reason: `Debugging required: ${redactedReason}`,
    },
  });
  dependencies.createDebugSession(redactedReason, debugState.recoveryPoint?.recoveryPointId ?? "recovery-point-unavailable");
  const recovered = await dependencies.recover(debugState, redactedReason);
  if (recovered.taskId !== state.taskId) {
    throw new InvalidTaskStateError("Recovery changed the stable task id");
  }
  if (recovered.environment !== state.environment) {
    throw new InvalidTaskStateError("Recovery changed the authoritative task environment");
  }
  if (recovered.stage !== "recover" || recovered.role !== "recovery-operator") {
    throw new InvalidTaskStateError("Recovery must return the recover stage and recovery-operator role");
  }
  assertStageTransition(debugState.stage, recovered.stage);
  const recoveredState = await persistState(dependencies.store, {
    ...recovered,
    routingDecision: recovered.routingDecision === null ? null : {
      ...recovered.routingDecision,
      stage: recovered.stage,
      environment: recovered.environment,
      role: recovered.role,
      reason: `Recovery outcome: ${redactedReason}`,
    },
    durableContext: null,
  });
  return response(recoveredState, "blocked", redactedReason);
}

async function requireActiveState(
  environment: Environment,
  activeTaskIds: ReadonlyMap<Environment, string>,
  store: DurableContextStore,
): Promise<TaskState | null> {
  const taskId = activeTaskIds.get(environment);
  return taskId === undefined ? null : store.load(taskId);
}

function transferTaskOwnership(activeTaskIds: Map<Environment, string>, taskId: string, environment: Environment): void {
  const nextOwners = new Map(activeTaskIds);
  for (const [owner, activeTaskId] of nextOwners) {
    if (activeTaskId === taskId || owner === environment) nextOwners.delete(owner);
  }
  nextOwners.set(environment, taskId);
  activeTaskIds.clear();
  for (const [owner, activeTaskId] of nextOwners) activeTaskIds.set(owner, activeTaskId);
}

async function executeIntent(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "intent" }>,
  dependencies: DAIRuntimeDependencies,
  activeTaskIds: Map<Environment, string>,
): Promise<DAIResponse> {
  const bootstrapped = await dependencies.bootstrapTask({
    taskId: null,
    goal: command.text,
    environment: request.sourceEnvironment,
    workspacePath: dependencies.workspacePath,
    repositoryPath: dependencies.repositoryPath,
  }, dependencies.store);
  const routed = await routeIntent(bootstrapped, request, dependencies);
  transferTaskOwnership(activeTaskIds, routed.state.taskId, routed.state.environment);
  const executionOutcome = await connectorOutcome(
    () => dependencies.adapters[routed.state.environment].execute({ state: routed.state, skills: routed.skills }),
    executionConnectorFailure,
  );
  if (executionOutcome.kind === "blocked") {
    return enterRecovery(routed.state, executionOutcome.message, dependencies);
  }
  const execution = validateExecutionResult(executionOutcome.value);
  const identityFailure = evidenceIdentityFailure(routed.state, execution.evidence);
  if (identityFailure !== null) {
    return enterRecovery(routed.state, identityFailure, dependencies);
  }
  if (execution.status !== "completed") {
    const executedState = await persistState(dependencies.store, {
      ...routed.state,
      verificationEvidence: [...routed.state.verificationEvidence, ...execution.evidence],
      durableContext: null,
    });
    return enterRecovery(executedState, execution.message, dependencies);
  }
  const inspectedTransition = transitionState(routed.state, "inspect", "evidence-collector", routed.state.environment);
  const inspectedState = await persistState(dependencies.store, {
    ...inspectedTransition,
    verificationEvidence: [...inspectedTransition.verificationEvidence, ...execution.evidence],
  });
  const preliminaryVerifyState = await persistState(
    dependencies.store,
    transitionState(inspectedState, "verify", "evidence-collector", inspectedState.environment),
  );
  const recoveryPointOutcome = await connectorOutcome(
    () => dependencies.captureRecoveryPoint(preliminaryVerifyState),
    executionConnectorFailure,
  );
  if (recoveryPointOutcome.kind === "blocked") {
    return enterRecovery(preliminaryVerifyState, recoveryPointOutcome.message, dependencies);
  }
  const recoveryFailure = recoveryPointFailure(preliminaryVerifyState, recoveryPointOutcome.value);
  if (recoveryFailure !== null) {
    return enterRecovery(preliminaryVerifyState, recoveryFailure, dependencies);
  }
  const verifiedState = await persistState(dependencies.store, {
    ...preliminaryVerifyState,
    verificationEvidence: preliminaryVerifyState.verificationEvidence.map((verification) => ({
      ...verification,
      recoveryPointId: recoveryPointOutcome.value.recoveryPointId,
    })),
    recoveryPoint: recoveryPointOutcome.value,
    durableContext: null,
  });
  const exactEvidenceFailure = gateEvidenceFailure(verifiedState.verificationEvidence);
  if (exactEvidenceFailure !== null) {
    return enterRecovery(verifiedState, exactEvidenceFailure, dependencies);
  }
  const gates = dependencies.evaluateHardGates({
    state: verifiedState,
    evidence: gateEvidence(verifiedState.verificationEvidence),
    now: dependencies.now(),
    maximumEvidenceAgeMs: dependencies.maximumEvidenceAgeMs,
  });
  const gateFailure = failedGateReason(gates);
  if (gateFailure !== null) {
    return enterRecovery(verifiedState, gateFailure, dependencies);
  }
  return response(verifiedState, "completed", execution.message);
}

async function continueTask(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "continue" }>,
  dependencies: DAIRuntimeDependencies,
  activeTaskIds: Map<Environment, string>,
): Promise<DAIResponse> {
  const state = await dependencies.store.load(command.taskIdOrProject);
  if (state === null) {
    return blockedWithoutState(command.taskIdOrProject, request.sourceEnvironment, `Task or project was not found: ${command.taskIdOrProject}`);
  }
  transferTaskOwnership(activeTaskIds, state.taskId, state.environment);
  return response(state, "accepted", `Continuing task ${state.taskId}`);
}

async function handoffTask(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "handoff" }>,
  dependencies: DAIRuntimeDependencies,
  activeTaskIds: Map<Environment, string>,
): Promise<DAIResponse> {
  const state = await requireActiveState(request.sourceEnvironment, activeTaskIds, dependencies.store);
  if (state === null) {
    return blockedWithoutState("unassigned", request.sourceEnvironment, "No active task is available for handoff");
  }
  if (state.handoffState !== "none") {
    return response(state, "blocked", `Task ${state.taskId} cannot hand off from state ${state.handoffState}`);
  }
  assertStageTransition(state.stage, "handoff");
  const handoffOutcome = await connectorOutcome(async () => {
    const envelope = await dependencies.handoffService.create({ state, targetEnvironment: command.target });
    await dependencies.adapters[command.target].receive(envelope);
    return envelope;
  }, handoffConnectorFailure);
  if (handoffOutcome.kind === "blocked") {
    return response(state, "blocked", handoffOutcome.message);
  }
  const handoffTransition = transitionState(state, "handoff", state.role, command.target);
  const handoffState = await persistState(dependencies.store, {
    ...handoffTransition,
    handoffState: "active",
    routingDecision: handoffTransition.routingDecision === null ? null : {
      ...handoffTransition.routingDecision,
      reason: `Handoff ownership transferred to ${command.target}`,
    },
  });
  transferTaskOwnership(activeTaskIds, state.taskId, command.target);
  return response(handoffState, "accepted", `Handoff ${handoffOutcome.value.handoffId} is owned by ${command.target}`);
}

async function closeActiveTask(
  request: DAIRequest,
  dependencies: DAIRuntimeDependencies,
  activeTaskIds: ReadonlyMap<Environment, string>,
): Promise<DAIResponse> {
  const state = await requireActiveState(request.sourceEnvironment, activeTaskIds, dependencies.store);
  if (state === null) {
    return blockedWithoutState("unassigned", request.sourceEnvironment, "No active task is available for close");
  }
  if (state.stage !== "verify") {
    return response(state, "blocked", `Task ${state.taskId} must reach verify before close; current stage is ${state.stage}`);
  }
  const closeState = await persistState(
    dependencies.store,
    transitionState(state, "close", "evidence-collector", state.environment),
  );
  const closeOutcome = await connectorOutcome(() => dependencies.closeTask(closeState), closeConnectorFailure);
  if (closeOutcome.kind === "blocked") {
    return response(closeState, "blocked", `Close connector blocked: ${closeOutcome.message}`);
  }
  const verdict = closeOutcome.value;
  const status: DAIResponse["status"] = verdict.status === "YES" ? "completed" : "blocked";
  const message = verdict.status === "YES"
    ? "Safe-to-delete: YES"
    : `Close verdict ${verdict.status}: ${verdict.reasons.join(" ")}`;
  return {
    taskId: verdict.taskId,
    stage: verdict.stage,
    environment: verdict.environment,
    status,
    evidence: verdict.evidence.map(redactEvidence),
    message: redactSensitiveText(message),
  };
}

export function createDAIRuntime(dependencies: DAIRuntimeDependencies): (request: ExternalDAIRequest) => Promise<DAIResponse> {
  validateDependencies(dependencies);
  const activeTaskIds = new Map<Environment, string>();
  return async (externalRequest: ExternalDAIRequest): Promise<DAIResponse> => {
    const request = validateRequest(externalRequest);
    if (request.command.kind === "intent") return executeIntent(request, request.command, dependencies, activeTaskIds);
    if (request.command.kind === "continue") return continueTask(request, request.command, dependencies, activeTaskIds);
    if (request.command.kind === "handoff") return handoffTask(request, request.command, dependencies, activeTaskIds);
    if (request.command.kind === "close") return closeActiveTask(request, dependencies, activeTaskIds);
    const state = await requireActiveState(request.sourceEnvironment, activeTaskIds, dependencies.store);
    return state === null
      ? blockedWithoutState("unassigned", request.sourceEnvironment, "No active task is available for status")
      : response(state, "accepted", `Task ${state.taskId} is ${state.stage} in ${state.environment}`);
  };
}

const defaultModelPolicies: readonly ModelPolicy[] = [{
  stage: "execute",
  role: "implementer",
  model: "codex-default",
  requiredCapabilities: ["local-execution"],
  compatibleEnvironments: ["codex"],
}];

function defaultExecutionAdapter(request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> {
  return Promise.resolve({
    status: "blocked",
    evidence: [],
    message: `No execution connector is configured for ${request.state.environment}`,
  });
}

function defaultRecovery(state: TaskState, reason: string): Promise<TaskState> {
  return Promise.resolve({
    ...state,
    stage: "recover",
    role: "recovery-operator",
    contextManifest: [...state.contextManifest, `blocked-recovery:${reason}`],
  });
}

function defaultCaptureRecoveryPoint(state: TaskState): Promise<RecoveryPoint> {
  return Promise.reject(new InvalidTaskStateError(`No recovery point connector is configured for ${state.taskId}`));
}

function createDefaultDependencies(): DAIRuntimeDependencies {
  const root = process.cwd();
  const durableRoot = join(root, ".d-ai");
  const store = new FileDurableContextStore(durableRoot);
  const handoffService = new PersistentHandoffService(new FileHandoffPersistence(join(durableRoot, "handoffs.json")));
  const gitHub = GitHubCliAdapter.create({ enterpriseHost: null });
  return {
    store,
    workspacePath: root,
    repositoryPath: root,
    skillRoots: [join(root, ".agents", "skills")],
    modelPolicies: defaultModelPolicies,
    adapters: {
      chat: new ChatEnvironmentAdapter(handoffService, defaultExecutionAdapter),
      work: new WorkEnvironmentAdapter(handoffService, defaultExecutionAdapter),
      codex: new CodexEnvironmentAdapter(handoffService, defaultExecutionAdapter),
    },
    handoffService,
    bootstrapTask,
    selectEnvironment,
    resolveModelRoute,
    discoverSkillMetadata,
    selectCapabilities,
    loadSelectedSkill,
    evaluateHardGates,
    createDebugSession,
    captureRecoveryPoint: defaultCaptureRecoveryPoint,
    recover: defaultRecovery,
    closeTask: (state: TaskState): Promise<CloseVerdict> => closeTask(state, { store, gitHub }),
    maximumEvidenceAgeMs: 300_000,
    now: (): Date => new Date(),
  };
}

const defaultRuntime = createDAIRuntime(createDefaultDependencies());

export async function handleDAIRequest(request: DAIRequest): Promise<DAIResponse> {
  return defaultRuntime(request);
}
