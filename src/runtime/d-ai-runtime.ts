import { join } from "node:path";
import { z } from "zod";
import { CommandExecutionError, redactSensitiveText } from "../adapters/command-runner.js";
import { ChatEnvironmentAdapter } from "../adapters/environments/chat-adapter.js";
import { CodexEnvironmentAdapter } from "../adapters/environments/codex-adapter.js";
import { WorkEnvironmentAdapter } from "../adapters/environments/work-adapter.js";
import { GitHubCliAdapter } from "../adapters/github.js";
import { bootstrapTask, prepareBootstrapTask } from "../bootstrap/bootstrap-task.js";
import { closeTask } from "../close/close-service.js";
import { createDebugSession, type DebugSession } from "../debugging/debug-session.js";
import {
  CapabilityMismatchError,
  CloseBlockedError,
  InvalidHandoffError,
  InvalidTaskStateError,
  TaskOwnershipError,
  UnsavedContextError,
  VerificationGateError,
} from "../domain/errors.js";
import { containsSecretShapedValue, isSafeManifestId } from "../domain/manifest-id.js";
import { hasExactPathHashEquality } from "../domain/recovery-integrity.js";
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
import type { DurableContextStore, TaskOwnershipLease } from "../state/durable-context-store.js";
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
  readonly stage?: string | null;
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
type PrepareBootstrapTask = typeof prepareBootstrapTask;
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
  readonly prepareBootstrapTask?: PrepareBootstrapTask | undefined;
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
  z.object({ kind: z.literal("complete"), handoffId: z.string().trim().min(1) }).strict(),
  z.object({ kind: z.literal("close") }).strict(),
]);
const overridesSchema = z.object({
  model: z.string().trim().min(1).nullable(),
  role: roleSchema.nullable(),
  environment: environmentSchema.nullable(),
  stage: stageSchema.nullable().optional(),
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
const recoveryPointSchema = z.object({
  recoveryPointId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  stage: stageSchema,
  environment: environmentSchema,
  role: roleSchema,
  durablePaths: z.array(z.string().trim().min(1)).min(1),
  hashes: z.record(z.string().trim().min(1), z.string().regex(/^[a-f0-9]{64}$/i)),
  restorationInstructions: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  snapshotManifestId: z.string().trim().refine(isSafeManifestId, "must be a UUID or manifest-UUID").optional(),
}).strict();

const baseApplicableExecutionGates = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "durable-context",
  "critical-unsaved-context",
] as const;

type ApplicableExecutionGate = typeof baseApplicableExecutionGates[number] | "recovery";
const secretLikeTextPattern = /\b(?:api[_-]?(?:key|token)|access[_-]?token|auth(?:orization)?|credentials?|cookies?|passwords?|passwd|private[_-]?key|secrets?|session[_-]?token|tokens?)\b/i;

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

interface RuntimeTaskRegistry {
  readonly activeTaskId: (environment: Environment) => string | null;
  readonly owner: (taskId: string) => Environment | null;
  readonly isActiveOwner: (taskId: string, environment: Environment) => boolean;
  readonly isBlocked: (taskId: string) => boolean;
  readonly transfer: (taskId: string, environment: Environment) => void;
  readonly block: (taskId: string) => void;
  readonly serializeMutation: (taskId: string, operation: () => Promise<DAIResponse>) => Promise<DAIResponse>;
}

function transferredOwners(
  owners: ReadonlyMap<Environment, string>,
  taskId: string,
  environment: Environment,
): ReadonlyMap<Environment, string> {
  const nextOwners = new Map(owners);
  for (const [owner, activeTaskId] of nextOwners) {
    if (activeTaskId === taskId || owner === environment) nextOwners.delete(owner);
  }
  nextOwners.set(environment, taskId);
  return nextOwners;
}

function ownersWithoutTask(owners: ReadonlyMap<Environment, string>, taskId: string): ReadonlyMap<Environment, string> {
  const nextOwners = new Map(owners);
  for (const [owner, activeTaskId] of nextOwners) {
    if (activeTaskId === taskId) nextOwners.delete(owner);
  }
  return nextOwners;
}

function createRuntimeTaskRegistry(): RuntimeTaskRegistry {
  let owners: ReadonlyMap<Environment, string> = new Map<Environment, string>();
  const blockedTaskIds = new Set<string>();
  const mutationQueues = new Map<string, Promise<void>>();
  return {
    activeTaskId: (environment: Environment): string | null => {
      const taskId = owners.get(environment);
      return taskId === undefined || blockedTaskIds.has(taskId) ? null : taskId;
    },
    owner: (taskId: string): Environment | null => {
      const owner = [...owners].find(([, activeTaskId]) => activeTaskId === taskId)?.[0];
      return owner ?? null;
    },
    isActiveOwner: (taskId: string, environment: Environment): boolean =>
      !blockedTaskIds.has(taskId) && owners.get(environment) === taskId,
    isBlocked: (taskId: string): boolean => blockedTaskIds.has(taskId),
    transfer: (taskId: string, environment: Environment): void => {
      owners = transferredOwners(owners, taskId, environment);
      blockedTaskIds.delete(taskId);
    },
    block: (taskId: string): void => {
      blockedTaskIds.add(taskId);
      owners = ownersWithoutTask(owners, taskId);
    },
    serializeMutation: async (taskId: string, operation: () => Promise<DAIResponse>): Promise<DAIResponse> => {
      const previous = mutationQueues.get(taskId) ?? Promise.resolve();
      let release: () => void = () => {};
      const current = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.then(() => current);
      mutationQueues.set(taskId, tail);
      await previous;
      try {
        return await operation();
      } finally {
        release();
        if (mutationQueues.get(taskId) === tail) mutationQueues.delete(taskId);
      }
    },
  };
}

function applicableExecutionGates(state: TaskState): readonly ApplicableExecutionGate[] {
  return state.recoveryPoint === null
    ? baseApplicableExecutionGates
    : [...baseApplicableExecutionGates, "recovery"];
}

function validationReason(issues: readonly z.ZodIssue[]): string {
  const issue = issues[0];
  return issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
}

function validateRequest(request: ExternalDAIRequest): DAIRequest {
  const result = requestSchema.safeParse(request);
  if (!result.success) {
    throw new InvalidTaskStateError(`Invalid D-AI request: ${validationReason(result.error.issues)}`);
  }
  return {
    ...result.data,
    overrides: {
      ...result.data.overrides,
      stage: result.data.overrides.stage ?? null,
    },
  };
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
  return {
    ...state,
    verificationEvidence: state.verificationEvidence.map(redactEvidence),
    ...(state.verificationHistory === undefined ? {} : { verificationHistory: state.verificationHistory.map(redactEvidence) }),
  };
}

async function persistState(store: DurableContextStore, state: TaskState, lease?: TaskOwnershipLease): Promise<TaskState> {
  const redactedState = redactStateEvidence(state);
  const manifest = await store.save(redactedState, lease);
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
  return error instanceof InvalidHandoffError || error instanceof CapabilityMismatchError || error instanceof InvalidTaskStateError || error instanceof TaskOwnershipError
    ? error.message
    : null;
}

async function withDurableTaskOwnership(
  taskId: string,
  environment: Environment,
  store: DurableContextStore,
  operation: (
    lease: TaskOwnershipLease,
    transfer: (targetEnvironment: Environment) => Promise<void>,
  ) => Promise<DAIResponse>,
): Promise<DAIResponse> {
  try {
    if (store.withTaskOwnership === undefined) {
      throw new InvalidTaskStateError("Durable task ownership is unavailable for a mutating runtime command");
    }
    return await store.withTaskOwnership(taskId, environment, async (lease, transfer) => operation(lease, transfer));
  } catch (error: unknown) {
    if (error instanceof TaskOwnershipError) {
      return blockedWithoutState(taskId, environment, error.message);
    }
    throw error;
  }
}

function completionConnectorFailure(error: Error): string | null {
  return error instanceof Error ? error.message : String(error);
}

function closeConnectorFailure(error: Error): string | null {
  return error instanceof CloseBlockedError ? error.message : null;
}

function recoveryConnectorFailure(error: Error): string | null {
  const executionFailure = executionConnectorFailure(error);
  if (executionFailure !== null) return executionFailure;
  if (
    error instanceof CapabilityMismatchError
    || error instanceof InvalidHandoffError
    || error instanceof CloseBlockedError
    || error instanceof VerificationGateError
    || error instanceof UnsavedContextError
  ) return error.message;
  return null;
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

const defaultRolesByStage: ReadonlyMap<Stage, Role> = new Map([
  ["bootstrap", "analyst"],
  ["route", "planner"],
  ["plan", "planner"],
  ["execute", "implementer"],
  ["inspect", "evidence-collector"],
  ["verify", "reviewer"],
  ["debug", "debugger"],
  ["recover", "recovery-operator"],
  ["handoff", "planner"],
  ["close", "reviewer"],
]);

function preferredEnvironment(
  sourceEnvironment: Environment,
  stage: Stage,
  role: Role,
  overrides: RoutingOverrides,
  policies: readonly ModelPolicy[],
): Environment {
  if (overrides.environment !== null) return overrides.environment;
  const policy = policies.find((candidate) =>
    candidate.stage === stage
    && candidate.role === role
    && (overrides.model === null || candidate.model === overrides.model),
  );
  return policy?.compatibleEnvironments[0] ?? sourceEnvironment;
}

function requestedStage(overrides: RoutingOverrides): Stage {
  return overrides.stage ?? "execute";
}

function requestedRole(stage: Stage, overrides: RoutingOverrides): Role {
  if (overrides.role !== null) return overrides.role;
  const role = defaultRolesByStage.get(stage);
  if (role === undefined) throw new InvalidTaskStateError(`No default role is declared for stage=${stage}`);
  return role;
}

async function routeIntent(
  state: TaskState,
  request: DAIRequest,
  dependencies: DAIRuntimeDependencies,
  lease: TaskOwnershipLease,
): Promise<{ readonly state: TaskState; readonly skills: readonly LoadedSkill[] }> {
  const stage = requestedStage(request.overrides);
  const role = requestedRole(stage, request.overrides);
  const candidateEnvironment = preferredEnvironment(request.sourceEnvironment, stage, role, request.overrides, dependencies.modelPolicies);
  const modelDecision = dependencies.resolveModelRoute(
    stage,
    role,
    candidateEnvironment,
    dependencies.modelPolicies,
    request.overrides,
  );
  const route = dependencies.selectEnvironment({
    stage,
    requiredCapabilities: modelDecision.selectedCapabilities,
    available: environmentSchema.options.map((environment) => dependencies.adapters[environment].capabilities()),
    userEnvironmentOverride: request.overrides.environment,
  });
  const routingDecision = route.environment === modelDecision.environment
    ? modelDecision
    : dependencies.resolveModelRoute(stage, role, route.environment, dependencies.modelPolicies, request.overrides);
  assertStageTransition(state.stage, "route");
  const routedState = await persistState(dependencies.store, {
    ...state,
    constraints: state.constraints.length === 0 ? ["Execute only the requested D-AI intent"] : state.constraints,
    environment: route.environment,
    stage: "route",
    role: "planner",
    routingDecision: {
      ...routingDecision,
      ...(request.overrides.stage === null || request.overrides.stage === undefined
        ? {}
        : { requestedStage: request.overrides.stage }),
      stage: "route",
      environment: route.environment,
      role: "planner",
    },
    selectedCapabilities: [...routingDecision.selectedCapabilities],
    durableContext: null,
  }, lease);
  const descriptors = await dependencies.discoverSkillMetadata(dependencies.skillRoots);
  const selected = dependencies.selectCapabilities(routedState.goal, stage, route.environment, descriptors);
  const skills = await Promise.all(selected.map((descriptor) => dependencies.loadSelectedSkill(descriptor, descriptor.requiredResources ?? [])));
  const contextManifest = [
    ...routedState.contextManifest,
    ...selected.map((descriptor) => `skill:${descriptor.name}:${descriptor.skillPath}`),
  ];
  const plannedState = await persistState(dependencies.store, {
    ...transitionState(routedState, "plan", "planner", route.environment),
    contextManifest,
  }, lease);
  const executionState = transitionState(plannedState, "execute", routingDecision.role, route.environment);
  return { state: await persistState(dependencies.store, executionState, lease), skills };
}

function gateEvidence(
  evidence: readonly VerificationEvidence[],
  applicableGates: readonly ApplicableExecutionGate[],
): readonly GateEvidence[] {
  return evidence.flatMap((verification) => {
    const gate: ApplicableExecutionGate | undefined = applicableGates.find((candidate) => verification.evidenceId === `gate:${candidate}`);
    return gate === undefined ? [] : [{ gate, verification }];
  });
}

function gateEvidenceFailure(
  evidence: readonly VerificationEvidence[],
  applicableGates: readonly ApplicableExecutionGate[],
): string | null {
  for (const gate of applicableGates) {
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

function secretLikeRecoveryPointField(recoveryPoint: RecoveryPoint): string | null {
  const fields: readonly { readonly label: string; readonly value: string }[] = [
    { label: "id", value: recoveryPoint.recoveryPointId },
    { label: "task id", value: recoveryPoint.taskId },
    { label: "stage", value: recoveryPoint.stage },
    { label: "environment", value: recoveryPoint.environment },
    { label: "role", value: recoveryPoint.role },
    { label: "restoration instructions", value: recoveryPoint.restorationInstructions },
    { label: "timestamp", value: recoveryPoint.createdAt },
    ...(recoveryPoint.snapshotManifestId === undefined ? [] : [{ label: "snapshot manifest id", value: recoveryPoint.snapshotManifestId }]),
    ...recoveryPoint.durablePaths.map((value, index) => ({ label: `durable path ${index}`, value })),
    ...Object.entries(recoveryPoint.hashes).flatMap(([key, value]) => [
      { label: "hash key", value: key },
      { label: `hash value for ${key}`, value },
    ]),
  ];
  const secretField = fields.find((field) =>
    redactSensitiveText(field.value) !== field.value
    || secretLikeTextPattern.test(field.value)
    || containsSecretShapedValue(field.value));
  return secretField === undefined ? null : `Captured recovery point ${secretField.label} contains secret-like content`;
}

function validateCapturedRecoveryPoint(
  state: TaskState,
  recoveryPoint: RecoveryPoint,
  now: Date,
): ConnectorOutcome<RecoveryPoint> {
  const parsed = recoveryPointSchema.safeParse(recoveryPoint);
  if (!parsed.success) {
    return { kind: "blocked", message: `Captured recovery point is malformed: ${validationReason(parsed.error.issues)}` };
  }
  const validated = parsed.data;
  const secretFailure = secretLikeRecoveryPointField(validated);
  if (secretFailure !== null) return { kind: "blocked", message: secretFailure };
  const manifest = state.durableContext;
  if (manifest === null) return { kind: "blocked", message: "Recovery point capture requires a persisted verify manifest" };
  if (!isSafeManifestId(manifest.manifestId)) return { kind: "blocked", message: "Persisted verify manifest id is unsafe" };
  if (
    validated.taskId !== state.taskId
    || validated.stage !== state.stage
    || validated.environment !== state.environment
    || validated.role !== state.role
  ) return { kind: "blocked", message: "Captured recovery point identity does not match the verify state" };
  const createdAt = Date.parse(validated.createdAt);
  if (Number.isNaN(now.getTime()) || createdAt > now.getTime()) {
    return { kind: "blocked", message: "Captured recovery point timestamp is malformed or in the future" };
  }
  const recoveryHashKeys = Object.keys(validated.hashes);
  const manifestHashKeys = Object.keys(manifest.hashes);
  if (
    validated.durablePaths.length === 0
    || new Set(validated.durablePaths).size !== validated.durablePaths.length
    || validated.durablePaths.some((path) => !manifest.durablePaths.includes(path) || validated.hashes[path] !== manifest.hashes[path])
    || recoveryHashKeys.length !== validated.durablePaths.length
    || recoveryHashKeys.some((key) => !validated.durablePaths.includes(key))
    || manifestHashKeys.some((key) => !manifest.durablePaths.includes(key))
    || !hasExactPathHashEquality(manifest.durablePaths, manifest.hashes, validated.durablePaths, validated.hashes)
  ) return { kind: "blocked", message: "Captured recovery point does not match the persisted verify artifacts" };
  return { kind: "success", value: validated };
}

function failedGateReason(
  results: readonly GateResult[],
  applicableGates: readonly ApplicableExecutionGate[],
): string | null {
  for (const requiredGate of applicableGates) {
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
  lease: TaskOwnershipLease,
): Promise<DAIResponse> {
  const redactedReason = redactSensitiveText(reason);
  const debugTransition = transitionState(state, "debug", "debugger", state.environment);
  const debugState = await persistState(dependencies.store, {
    ...debugTransition,
    routingDecision: debugTransition.routingDecision === null ? null : {
      ...debugTransition.routingDecision,
      reason: `Debugging required: ${redactedReason}`,
    },
  }, lease);
  const recoveryOutcome = await connectorOutcome(async () => {
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
    return persistState(dependencies.store, {
      ...recovered,
      routingDecision: recovered.routingDecision === null ? null : {
        ...recovered.routingDecision,
        stage: recovered.stage,
        environment: recovered.environment,
        role: recovered.role,
        reason: `Recovery outcome: ${redactedReason}`,
      },
      durableContext: null,
    }, lease);
  }, recoveryConnectorFailure);
  return recoveryOutcome.kind === "blocked"
    ? response(debugState, "blocked", `Recovery connector blocked: ${recoveryOutcome.message}`)
    : response(recoveryOutcome.value, "blocked", redactedReason);
}

async function requireActiveState(
  environment: Environment,
  registry: RuntimeTaskRegistry,
  store: DurableContextStore,
): Promise<TaskState | null> {
  const taskId = registry.activeTaskId(environment);
  if (taskId === null) return null;
  const state = await store.load(taskId);
  return registry.isActiveOwner(taskId, environment) ? state : null;
}

async function executeRoutedState(
  routedState: TaskState,
  skills: readonly LoadedSkill[],
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
  lease: TaskOwnershipLease,
): Promise<DAIResponse> {
  registry.transfer(routedState.taskId, routedState.environment);
  const executionOutcome = await connectorOutcome(
    () => dependencies.adapters[routedState.environment].execute({ state: routedState, skills }),
    executionConnectorFailure,
  );
  if (executionOutcome.kind === "blocked") {
    return enterRecovery(routedState, executionOutcome.message, dependencies, lease);
  }
  const execution = validateExecutionResult(executionOutcome.value);
  const identityFailure = evidenceIdentityFailure(routedState, execution.evidence);
  if (identityFailure !== null) {
    return enterRecovery(routedState, identityFailure, dependencies, lease);
  }
  if (execution.status !== "completed") {
    const executedState = await persistState(dependencies.store, {
      ...routedState,
      verificationEvidence: [...routedState.verificationEvidence, ...execution.evidence],
      durableContext: null,
    }, lease);
    return enterRecovery(executedState, execution.message, dependencies, lease);
  }
  const inspectedTransition = transitionState(routedState, "inspect", "evidence-collector", routedState.environment);
  const inspectedState = await persistState(dependencies.store, {
    ...inspectedTransition,
    verificationEvidence: [...inspectedTransition.verificationEvidence, ...execution.evidence],
  }, lease);
  const preliminaryVerifyState = await persistState(
    dependencies.store,
    transitionState(inspectedState, "verify", "evidence-collector", inspectedState.environment),
    lease,
  );
  const recoveryPointOutcome = await connectorOutcome(
    () => dependencies.captureRecoveryPoint(preliminaryVerifyState),
    executionConnectorFailure,
  );
  if (recoveryPointOutcome.kind === "blocked") {
    return enterRecovery(preliminaryVerifyState, recoveryPointOutcome.message, dependencies, lease);
  }
  const recoveryPointValidation = validateCapturedRecoveryPoint(
    preliminaryVerifyState,
    recoveryPointOutcome.value,
    dependencies.now(),
  );
  if (recoveryPointValidation.kind === "blocked") {
    return enterRecovery(preliminaryVerifyState, recoveryPointValidation.message, dependencies, lease);
  }
  const verifiedState = await persistState(dependencies.store, {
    ...preliminaryVerifyState,
    verificationEvidence: preliminaryVerifyState.verificationEvidence.map((verification) => ({
      ...verification,
      recoveryPointId: recoveryPointValidation.value.recoveryPointId,
    })),
    recoveryPoint: recoveryPointValidation.value,
    durableContext: null,
  }, lease);
  const applicableGates = applicableExecutionGates(verifiedState);
  const exactEvidenceFailure = gateEvidenceFailure(verifiedState.verificationEvidence, applicableGates);
  if (exactEvidenceFailure !== null) {
    return enterRecovery(verifiedState, exactEvidenceFailure, dependencies, lease);
  }
  const gates = dependencies.evaluateHardGates({
    state: verifiedState,
    evidence: gateEvidence(verifiedState.verificationEvidence, applicableGates),
    now: dependencies.now(),
    maximumEvidenceAgeMs: dependencies.maximumEvidenceAgeMs,
  });
  const gateFailure = failedGateReason(gates, applicableGates);
  if (gateFailure !== null) {
    return enterRecovery(verifiedState, gateFailure, dependencies, lease);
  }
  return response(verifiedState, "completed", execution.message);
}

async function executeIntentExclusive(
  request: DAIRequest,
  bootstrapped: TaskState,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
  lease: TaskOwnershipLease,
): Promise<DAIResponse> {
  const routed = await routeIntent(bootstrapped, request, dependencies, lease);
  return executeRoutedState(routed.state, routed.skills, dependencies, registry, lease);
}

async function executeIntent(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "intent" }>,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
): Promise<DAIResponse> {
  const prepare = dependencies.prepareBootstrapTask ?? prepareBootstrapTask;
  const bootstrapped = await prepare({
    taskId: null,
    goal: command.text,
    environment: request.sourceEnvironment,
    workspacePath: dependencies.workspacePath,
    repositoryPath: dependencies.repositoryPath,
  }, dependencies.store);
  return registry.serializeMutation(
    bootstrapped.taskId,
    () => withDurableTaskOwnership(
      bootstrapped.taskId,
      request.sourceEnvironment,
      dependencies.store,
      async (lease) => {
        const existing = await dependencies.store.load(bootstrapped.taskId);
        const ownedBootstrap = existing ?? (
          bootstrapped.durableContext === null
            ? await persistState(dependencies.store, bootstrapped, lease)
            : bootstrapped
        );
        return executeIntentExclusive(request, ownedBootstrap, dependencies, registry, lease);
      },
    ),
  );
}

async function continueTaskExclusive(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "continue" }>,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
  lease: TaskOwnershipLease,
): Promise<DAIResponse> {
  if (registry.isBlocked(command.taskIdOrProject)) {
    return blockedWithoutState(command.taskIdOrProject, request.sourceEnvironment, `Task ${command.taskIdOrProject} is blocked by a failed handoff`);
  }
  const state = await dependencies.store.load(command.taskIdOrProject);
  if (state === null) {
    return blockedWithoutState(command.taskIdOrProject, request.sourceEnvironment, `Task or project was not found: ${command.taskIdOrProject}`);
  }
  if (request.sourceEnvironment !== state.environment) {
    return response(state, "blocked", `Task ${state.taskId} is owned by ${state.environment}, not ${request.sourceEnvironment}`);
  }
  const owner = registry.owner(state.taskId);
  if (registry.isBlocked(state.taskId) || (owner !== null && owner !== state.environment)) {
    return response(state, "blocked", `Task ${state.taskId} ownership changed while continue was loading durable state`);
  }
  if (state.handoffState === "pending" || state.handoffState === "acknowledged" || state.handoffState === "rejected") {
    return response(state, "blocked", `Task ${state.taskId} cannot continue from handoff state ${state.handoffState}`);
  }
  if (state.stage === "recover") {
    const descriptors = await dependencies.discoverSkillMetadata(dependencies.skillRoots);
    const selected = dependencies.selectCapabilities(state.goal, "execute", state.environment, descriptors);
    const skills = await Promise.all(selected.map((descriptor) => dependencies.loadSelectedSkill(descriptor, descriptor.requiredResources ?? [])));
    const failedEvidence = state.verificationEvidence.filter((evidence) => !evidence.passed);
    const executionState = await persistState(
      dependencies.store,
      {
        ...transitionState(state, "execute", "implementer", state.environment),
        verificationEvidence: [],
        verificationHistory: [...(state.verificationHistory ?? []), ...state.verificationEvidence],
        contextManifest: failedEvidence.length === 0
          ? [...state.contextManifest]
          : [...state.contextManifest, `recovered-from-failure:${failedEvidence.map((evidence) => evidence.evidenceId).join(",")}`],
      },
      lease,
    );
    registry.transfer(state.taskId, state.environment);
    return executeRoutedState(executionState, skills, dependencies, registry, lease);
  }
  registry.transfer(state.taskId, state.environment);
  return response(state, "accepted", `Continuing task ${state.taskId}`);
}

async function continueTask(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "continue" }>,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
): Promise<DAIResponse> {
  const state = await dependencies.store.load(command.taskIdOrProject);
  if (state === null) {
    return blockedWithoutState(command.taskIdOrProject, request.sourceEnvironment, `Task or project was not found: ${command.taskIdOrProject}`);
  }
  return registry.serializeMutation(
    state.taskId,
    () => withDurableTaskOwnership(
      state.taskId,
      request.sourceEnvironment,
      dependencies.store,
      async (lease) => continueTaskExclusive(request, command, dependencies, registry, lease),
    ),
  );
}

async function finalizeFailedHandoff(
  pendingState: TaskState,
  envelope: HandoffEnvelope | null,
  reason: string,
  dependencies: DAIRuntimeDependencies,
  lease: TaskOwnershipLease,
): Promise<{ readonly state: TaskState; readonly message: string }> {
  let message = redactSensitiveText(reason);
  if (envelope !== null) {
    const rejectionOutcome = await connectorOutcome(
      () => dependencies.handoffService.reject(envelope.handoffId, message),
      handoffConnectorFailure,
    );
    if (rejectionOutcome.kind === "blocked") {
      message = `${message}; handoff rejection blocked: ${rejectionOutcome.message}`;
    }
  }
  const rejectedCandidate: TaskState = {
    ...pendingState,
    handoffState: "rejected",
    routingDecision: pendingState.routingDecision === null ? null : {
      ...pendingState.routingDecision,
      reason: `Handoff failed: ${message}`,
    },
    durableContext: null,
  };
  const persistenceOutcome = await connectorOutcome(
    () => persistState(dependencies.store, rejectedCandidate, lease),
    handoffConnectorFailure,
  );
  return persistenceOutcome.kind === "blocked"
    ? { state: pendingState, message: `${message}; rejected handoff persistence blocked: ${persistenceOutcome.message}` }
    : { state: persistenceOutcome.value, message };
}

async function handoffTaskExclusive(
  taskId: string,
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "handoff" }>,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
  lease: TaskOwnershipLease,
  transferOwnership: (targetEnvironment: Environment) => Promise<void>,
): Promise<DAIResponse> {
  if (!registry.isActiveOwner(taskId, request.sourceEnvironment)) {
    return blockedWithoutState(taskId, request.sourceEnvironment, `Source operations are blocked while task ${taskId} changes handoff ownership`);
  }
  const state = await dependencies.store.load(taskId);
  if (state === null) {
    registry.block(taskId);
    return blockedWithoutState(taskId, request.sourceEnvironment, `Task ${taskId} is unavailable for handoff`);
  }
  if (state.handoffState !== "none") {
    return response(state, "blocked", `Task ${state.taskId} cannot hand off from state ${state.handoffState}`);
  }
  const handoffTransition = transitionState(state, "handoff", state.role, state.environment);
  const pendingCandidate: TaskState = {
    ...handoffTransition,
    handoffState: "pending",
    routingDecision: handoffTransition.routingDecision === null ? null : {
      ...handoffTransition.routingDecision,
      reason: `Handoff pending acknowledgement from ${command.target}`,
    },
  };
  registry.block(taskId);
  let envelope: HandoffEnvelope | null = null;
  let pendingState = pendingCandidate;
  const handoffOutcome = connectorOutcome(async () => {
    pendingState = await persistState(dependencies.store, pendingCandidate, lease);
    envelope = await dependencies.handoffService.create({ state, targetEnvironment: command.target });
    await dependencies.adapters[command.target].receive(envelope);
    const activeCandidate: TaskState = {
      ...pendingState,
      environment: command.target,
      handoffState: "active",
      contextManifest: [...pendingState.contextManifest, `handoff-source:${state.environment}`],
      routingDecision: pendingState.routingDecision === null ? null : {
        ...pendingState.routingDecision,
        environment: command.target,
        reason: `Handoff ownership transferred to ${command.target}`,
      },
      durableContext: null,
    };
    const activeState = await persistState(dependencies.store, activeCandidate, lease);
    await transferOwnership(command.target);
    return {
      envelope,
      state: activeState,
    };
  }, handoffConnectorFailure);
  return handoffOutcome.then(
    async (outcome): Promise<DAIResponse> => {
      if (outcome.kind === "blocked") {
        const failed = await finalizeFailedHandoff(pendingState, envelope, outcome.message, dependencies, lease);
        return response(failed.state, "blocked", failed.message);
      }
      registry.transfer(taskId, command.target);
      return response(outcome.value.state, "accepted", `Handoff ${outcome.value.envelope.handoffId} is owned by ${command.target}`);
    },
    async (error: Error): Promise<DAIResponse> => {
      await finalizeFailedHandoff(pendingState, envelope, error.message, dependencies, lease);
      return Promise.reject(error);
    },
  );
}

async function handoffTask(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "handoff" }>,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
): Promise<DAIResponse> {
  const taskId = registry.activeTaskId(request.sourceEnvironment);
  if (taskId === null) {
    return blockedWithoutState("unassigned", request.sourceEnvironment, "No active task is available for handoff");
  }
  return registry.serializeMutation(
    taskId,
    () => withDurableTaskOwnership(
      taskId,
      request.sourceEnvironment,
      dependencies.store,
      async (lease, transfer) => handoffTaskExclusive(taskId, request, command, dependencies, registry, lease, transfer),
    ),
  );
}

async function completeHandoffExclusive(
  taskId: string,
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "complete" }>,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
  lease: TaskOwnershipLease,
): Promise<DAIResponse> {
  if (!registry.isActiveOwner(taskId, request.sourceEnvironment)) {
    return blockedWithoutState(taskId, request.sourceEnvironment, `Task ${taskId} is not owned by ${request.sourceEnvironment}`);
  }
  const loadedState = await connectorOutcome(() => dependencies.store.load(taskId), completionConnectorFailure);
  if (loadedState.kind === "blocked") {
    return blockedWithoutState(taskId, request.sourceEnvironment, `Handoff completion blocked: ${loadedState.message}`);
  }
  if (loadedState.value === null) {
    return blockedWithoutState(taskId, request.sourceEnvironment, `Task ${taskId} is unavailable for handoff completion`);
  }
  const state = loadedState.value;
  const handoffStatus = await connectorOutcome(
    () => Promise.resolve(dependencies.adapters[request.sourceEnvironment].status(command.handoffId)),
    completionConnectorFailure,
  );
  if (handoffStatus.kind === "blocked") {
    return response(state, "blocked", `Handoff completion blocked: ${handoffStatus.message}`);
  }
  if (handoffStatus.value.taskId !== taskId || handoffStatus.value.target !== request.sourceEnvironment) {
    return response(state, "blocked", `Handoff ${command.handoffId} does not belong to active task ${taskId} and target ${request.sourceEnvironment}`);
  }
  if (handoffStatus.value.owner !== request.sourceEnvironment) {
    return response(state, "blocked", `Handoff ${command.handoffId} is not actively owned by ${request.sourceEnvironment}`);
  }
  const retryingCompletedHandoff = state.stage === "verify"
    && state.handoffState === "completed"
    && handoffStatus.value.state === "completed";
  if (!retryingCompletedHandoff && (state.stage !== "handoff" || state.handoffState !== "active")) {
    return response(state, "blocked", `Task ${taskId} cannot complete a handoff from stage ${state.stage} and handoff state ${state.handoffState}`);
  }
  if (handoffStatus.value.state !== "active" && handoffStatus.value.state !== "completed") {
    return response(state, "blocked", `Handoff ${command.handoffId} cannot complete from state ${handoffStatus.value.state}`);
  }
  const priorRecoveryPointId = state.recoveryPoint?.recoveryPointId;
  if (priorRecoveryPointId === undefined) {
    return response(state, "blocked", "Handoff completion blocked: no prior recovery point is available");
  }
  if (handoffStatus.value.state === "active") {
    const completion = await connectorOutcome(
      () => dependencies.handoffService.complete(command.handoffId, request.sourceEnvironment),
      completionConnectorFailure,
    );
    if (completion.kind === "blocked") {
      return response(state, "blocked", `Handoff completion blocked: ${completion.message}`);
    }
  }
  const completedCandidate: TaskState = retryingCompletedHandoff
    ? state
    : {
      ...transitionState(state, "verify", "evidence-collector", request.sourceEnvironment),
      contextManifest: [...state.contextManifest],
      verificationEvidence: [...state.verificationEvidence, {
        evidenceId: "gate:handoff",
        stage: "verify",
        environment: request.sourceEnvironment,
        role: "evidence-collector",
        selectedModel: state.routingDecision?.selectedModel ?? "unrecorded-model",
        command: `handoff complete ${command.handoffId}`,
        observedOutput: `Handoff ${command.handoffId} completed by ${request.sourceEnvironment}`,
        exitCode: 0,
        interpretation: "The durable handoff service completed ownership transfer",
        passed: true,
        recoveryPointId: priorRecoveryPointId,
        recordedAt: dependencies.now().toISOString(),
      }],
      handoffState: "completed",
    };
  const completedState = await connectorOutcome(
    () => persistState(dependencies.store, completedCandidate, lease),
    completionConnectorFailure,
  );
  if (completedState.kind === "blocked") {
    return response(state, "blocked", `Handoff completion persistence blocked after service completion: ${completedState.message}`);
  }
  const recoveryPoint = await connectorOutcome(
    () => dependencies.captureRecoveryPoint(completedState.value),
    completionConnectorFailure,
  );
  if (recoveryPoint.kind === "blocked") {
    return response(completedState.value, "blocked", `Handoff completion recovery capture blocked: ${recoveryPoint.message}`);
  }
  if (recoveryPoint.value.recoveryPointId !== priorRecoveryPointId) {
    return response(completedState.value, "blocked", "Handoff completion recovery capture returned a new identity");
  }
  const recoveryValidation = validateCapturedRecoveryPoint(completedState.value, recoveryPoint.value, dependencies.now());
  if (recoveryValidation.kind === "blocked") {
    return response(completedState.value, "blocked", `Handoff completion recovery capture blocked: ${recoveryValidation.message}`);
  }
  const persisted = await connectorOutcome(
    () => persistState(dependencies.store, { ...completedState.value, recoveryPoint: recoveryValidation.value }, lease),
    completionConnectorFailure,
  );
  if (persisted.kind === "blocked") {
    return response(completedState.value, "blocked", `Handoff completion persistence blocked: ${persisted.message}`);
  }
  return response(persisted.value, "completed", `Handoff ${command.handoffId} completed; task ${taskId} returned to verify`);
}

async function completeHandoff(
  request: DAIRequest,
  command: Extract<DAICommand, { readonly kind: "complete" }>,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
): Promise<DAIResponse> {
  const taskId = registry.activeTaskId(request.sourceEnvironment);
  if (taskId === null) {
    return blockedWithoutState("unassigned", request.sourceEnvironment, "No active durable task is available for handoff completion");
  }
  return registry.serializeMutation(
    taskId,
    () => withDurableTaskOwnership(
      taskId,
      request.sourceEnvironment,
      dependencies.store,
      async (lease) => completeHandoffExclusive(taskId, request, command, dependencies, registry, lease),
    ),
  );
}

async function closeActiveTaskExclusive(
  taskId: string,
  request: DAIRequest,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
  lease: TaskOwnershipLease,
): Promise<DAIResponse> {
  if (!registry.isActiveOwner(taskId, request.sourceEnvironment)) {
    return blockedWithoutState(taskId, request.sourceEnvironment, `Task ${taskId} is not owned by ${request.sourceEnvironment}`);
  }
  const state = await dependencies.store.load(taskId);
  if (state === null || !registry.isActiveOwner(taskId, request.sourceEnvironment)) {
    return blockedWithoutState(taskId, request.sourceEnvironment, `Task ${taskId} became unavailable while close was loading durable state`);
  }
  if (state.stage !== "verify") {
    return response(state, "blocked", `Task ${state.taskId} must reach verify before close; current stage is ${state.stage}`);
  }
  const closeOutcome = await connectorOutcome(() => dependencies.closeTask(state), closeConnectorFailure);
  if (closeOutcome.kind === "blocked") {
    return response(state, "blocked", `Close connector blocked: ${closeOutcome.message}`);
  }
  const verdict = closeOutcome.value;
  if (verdict.status !== "YES") {
    const status: DAIResponse["status"] = "blocked";
    const message = `Close verdict ${verdict.status}: ${verdict.reasons.join(" ")}`;
    return {
      taskId: state.taskId,
      stage: state.stage,
      environment: state.environment,
      status,
      evidence: verdict.evidence.map(redactEvidence),
      message: redactSensitiveText(message),
    };
  }
  const closeCandidate = verdict.closeCandidate;
  if (closeCandidate === null) {
    return response(state, "blocked", "Close verification returned YES without a durable close candidate");
  }
  const closeState = await connectorOutcome(
    async () => {
      const latestState = await dependencies.store.load(taskId);
      if (latestState === null || JSON.stringify(latestState) !== JSON.stringify(state)) {
        throw new CloseBlockedError("Task context changed after close verification and before final close persistence");
      }
      if (
        closeCandidate.taskId !== state.taskId
        || JSON.stringify(closeCandidate.durableContext) !== JSON.stringify(state.durableContext)
        || JSON.stringify(closeCandidate.contextManifest) !== JSON.stringify(state.contextManifest)
        || JSON.stringify(closeCandidate.criticalUnsavedContext) !== JSON.stringify(state.criticalUnsavedContext)
      ) {
        throw new CloseBlockedError("Durable close candidate does not match the task being persisted after verification");
      }
      return persistState(dependencies.store, {
        ...transitionState(state, "close", "evidence-collector", state.environment),
        verificationEvidence: [...verdict.evidence],
        closeCandidate,
      }, lease);
    },
    closeConnectorFailure,
  );
  if (closeState.kind === "blocked") {
    return response(state, "blocked", `Close persistence blocked after successful close verification: ${closeState.message}`);
  }
  const status: DAIResponse["status"] = "completed";
  const message = "Safe-to-delete: YES";
  return {
    taskId: closeState.value.taskId,
    stage: closeState.value.stage,
    environment: closeState.value.environment,
    status,
    evidence: verdict.evidence.map(redactEvidence),
    message: redactSensitiveText(message),
  };
}

async function closeActiveTask(
  request: DAIRequest,
  dependencies: DAIRuntimeDependencies,
  registry: RuntimeTaskRegistry,
): Promise<DAIResponse> {
  const taskId = registry.activeTaskId(request.sourceEnvironment);
  if (taskId === null) {
    return blockedWithoutState("unassigned", request.sourceEnvironment, "No active task is available for close");
  }
  return registry.serializeMutation(
    taskId,
    () => withDurableTaskOwnership(
      taskId,
      request.sourceEnvironment,
      dependencies.store,
      async (lease) => closeActiveTaskExclusive(taskId, request, dependencies, registry, lease),
    ),
  );
}

export function createDAIRuntime(dependencies: DAIRuntimeDependencies): (request: ExternalDAIRequest) => Promise<DAIResponse> {
  validateDependencies(dependencies);
  const registry = createRuntimeTaskRegistry();
  return async (externalRequest: ExternalDAIRequest): Promise<DAIResponse> => {
    const request = validateRequest(externalRequest);
    if (request.command.kind === "intent") return executeIntent(request, request.command, dependencies, registry);
    if (request.command.kind === "continue") return continueTask(request, request.command, dependencies, registry);
    if (request.command.kind === "handoff") return handoffTask(request, request.command, dependencies, registry);
    if (request.command.kind === "complete") return completeHandoff(request, request.command, dependencies, registry);
    if (request.command.kind === "close") return closeActiveTask(request, dependencies, registry);
    const state = await requireActiveState(request.sourceEnvironment, registry, dependencies.store);
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
  const gitHub = GitHubCliAdapter.create({ mode: "external", enterpriseHost: null, credentialsConfigured: process.env.D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED === "1" });
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
    prepareBootstrapTask,
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
