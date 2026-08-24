import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { CommandExecutionError, runCommand } from "../../src/adapters/command-runner.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { bootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { closeTask } from "../../src/close/close-service.js";
import { CloseBlockedError, InvalidTaskStateError, TaskOwnershipError } from "../../src/domain/errors.js";
import type { CloseCandidate, CloseVerdict, DurableContextManifest, Environment, RecoveryPoint, RecoverySnapshot, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { parseDAICommand } from "../../src/entry/command-parser.js";
import { InMemoryHandoffPersistence, PersistentHandoffService, type HandoffPersistenceRecord, type HandoffService, type HandoffStatus } from "../../src/handoff/handoff-service.js";
import type { HandoffEnvelope } from "../../src/handoff/envelope.js";
import type { GitHubAdapter, GitPushEvidence, RemoteState } from "../../src/adapters/github.js";
import type { EnvironmentCapabilities } from "../../src/routing/environment-capabilities.js";
import { selectEnvironment } from "../../src/routing/environment-router.js";
import { resolveModelRoute, type ModelPolicy } from "../../src/routing/model-router.js";
import { createDebugSession } from "../../src/debugging/debug-session.js";
import type { CapturedRecoveryPoint } from "../../src/recovery/recovery-point-service.js";
import { createGitRollbackTask } from "../../src/recovery/git-rollback-adapter.js";
import { RollbackPartialFailureError, type RollbackResult } from "../../src/recovery/rollback.js";
import {
  createDAIRuntime,
  type DAIEnvironmentAdapter,
  type DAIRequest,
  type DAIResponse,
  type DAIRuntimeDependencies,
  type EnvironmentExecutionRequest,
  type EnvironmentExecutionResult,
  type ExternalDAIRequest,
} from "../../src/runtime/d-ai-runtime.js";
import { discoverSkillMetadata, selectCapabilities } from "../../src/skills/registry.js";
import { loadSelectedSkill } from "../../src/skills/skill-loader.js";
import type {
  DurableContextStore,
  TaskOwnershipGuard,
  TaskOwnershipLease,
  TaskOwnershipTransfer,
  TaskOwnershipTransition,
  TaskOwnershipTransitionAuthorizer,
} from "../../src/state/durable-context-store.js";
import { FILE_DURABLE_CONTEXT_LEASE_MS, FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { evaluateHardGates, type GateResult, type HardGateInput } from "../../src/verification/gates.js";

const skillRoot = join(process.cwd(), "tests", "fixtures", "skills");
const workspacePath = join(process.cwd(), "tests", "fixtures");
const policies: readonly ModelPolicy[] = [
  {
    stage: "execute",
    role: "implementer",
    model: "codex-model",
    requiredCapabilities: ["local-execution"],
    compatibleEnvironments: ["codex"],
  },
];
const executionGateNames = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "recovery",
  "durable-context",
  "critical-unsaved-context",
] as const;

type ExecutionResultFactory = (request: EnvironmentExecutionRequest) => EnvironmentExecutionResult;

interface RuntimeHarness {
  readonly dependencies: DAIRuntimeDependencies;
  readonly executed: EnvironmentExecutionRequest[];
  readonly loadedSkills: string[];
  readonly recoveredReasons: string[];
  readonly savedStates: TaskState[];
  readonly closedStates: TaskState[];
  readonly handoffService: PersistentHandoffService;
  readonly store: DurableContextStore;
}

function inMemoryTaskOwnership<T>(
  taskId: string,
  environment: Environment,
  operation: (
    lease: TaskOwnershipLease,
    transfer: TaskOwnershipTransfer,
    assertOwnership: TaskOwnershipGuard,
    authorizeTransition: TaskOwnershipTransitionAuthorizer,
  ) => Promise<T>,
): Promise<T> {
  const lease: TaskOwnershipLease = { taskId, environment, generation: 1n, ownerToken: "00000000-0000-4000-8000-000000000001" };
  return operation(
    lease,
    async (targetEnvironment: Environment): Promise<TaskOwnershipLease> => ({ ...lease, environment: targetEnvironment }),
    async (): Promise<void> => {},
    (targetEnvironment) => targetEnvironment === lease.environment ? lease : { lease, targetEnvironment } as TaskOwnershipTransition,
  );
}

function observeFileStoreOwnership(fileStore: FileDurableContextStore): {
  readonly store: DurableContextStore;
  readonly transitions: () => readonly Environment[];
  readonly transfers: () => readonly Environment[];
  readonly events: () => readonly string[];
} {
  const transitions: Environment[] = [];
  const transfers: Environment[] = [];
  const events: string[] = [];
  const store: DurableContextStore = {
    load: (taskId): Promise<TaskState | null> => fileStore.load(taskId),
    loadGenerationManifest: (taskId, manifestId): Promise<DurableContextManifest> => fileStore.loadGenerationManifest(taskId, manifestId),
    verifyDurableSnapshot: (manifest): Promise<void> => fileStore.verifyDurableSnapshot(manifest),
    save: (state, authorization): Promise<DurableContextManifest> => fileStore.save(state, authorization),
    saveCloseCandidate: (candidate, lease): Promise<void> => fileStore.saveCloseCandidate(candidate, lease),
    loadCloseCandidate: (taskId): Promise<CloseCandidate | null> => fileStore.loadCloseCandidate(taskId),
    recordCriticalUnsavedContext: (taskId, items, lease): Promise<void> => fileStore.recordCriticalUnsavedContext(taskId, items, lease),
    clearCriticalUnsavedContext: (taskId, lease): Promise<void> => fileStore.clearCriticalUnsavedContext(taskId, lease),
    withTaskOwnership: <T>(
      taskId: string,
      environment: Environment,
      operation: (
        lease: TaskOwnershipLease,
        transfer: TaskOwnershipTransfer,
        assertOwnership: TaskOwnershipGuard,
        authorizeTransition: TaskOwnershipTransitionAuthorizer,
      ) => Promise<T>,
    ): Promise<T> => fileStore.withTaskOwnership(
      taskId,
      environment,
      (lease, transfer, assertOwnership, authorizeTransition): Promise<T> => operation(
        lease,
        async (targetEnvironment: Environment): Promise<TaskOwnershipLease> => {
          transfers.push(targetEnvironment);
          events.push(`transfer:start:${targetEnvironment}`);
          return transfer(targetEnvironment).then((targetLease) => {
            events.push(`transfer:complete:${targetEnvironment}`);
            return targetLease;
          });
        },
        assertOwnership,
        (targetEnvironment: Environment) => {
          transitions.push(targetEnvironment);
          events.push(`transition:${targetEnvironment}`);
          return authorizeTransition(targetEnvironment);
        },
      ),
    ),
  };
  return {
    store,
    transitions: (): readonly Environment[] => [...transitions],
    transfers: (): readonly Environment[] => [...transfers],
    events: (): readonly string[] => [...events],
  };
}

function memoryStore(savedStates: TaskState[], durablePath: string): DurableContextStore {
  const states = new Map<string, TaskState>();
  return {
    load: async (taskId: string): Promise<TaskState | null> => states.get(taskId) ?? null,
    save: async (state: TaskState): Promise<DurableContextManifest> => {
      savedStates.push(state);
      const manifest: DurableContextManifest = {
        manifestId: "00000000-0000-4000-8000-000000000008",
        taskId: state.taskId,
        stage: state.stage,
        environment: state.environment,
        role: state.role,
        durablePaths: [durablePath],
        hashes: { [durablePath]: "a".repeat(64) },
        recoveryPointId: state.recoveryPoint?.recoveryPointId ?? null,
        recordedAt: "2026-08-21T00:00:00.000Z",
      };
      states.set(state.taskId, { ...state, durableContext: manifest });
      return manifest;
    },
    recordCriticalUnsavedContext: async (taskId: string, items: readonly string[]): Promise<void> => {
      const state = states.get(taskId);
      if (state === undefined) throw new InvalidTaskStateError(`Missing task ${taskId}`);
      states.set(taskId, { ...state, criticalUnsavedContext: [...items] });
    },
    clearCriticalUnsavedContext: async (taskId: string): Promise<void> => {
      const state = states.get(taskId);
      if (state === undefined) throw new InvalidTaskStateError(`Missing task ${taskId}`);
      states.set(taskId, { ...state, criticalUnsavedContext: [] });
    },
    withTaskOwnership: inMemoryTaskOwnership,
  };
}

function adapterWithReceiveProbe(
  adapter: DAIEnvironmentAdapter,
  probe: (envelope: HandoffEnvelope) => void,
): DAIEnvironmentAdapter {
  return {
    capabilities: (): EnvironmentCapabilities => adapter.capabilities(),
    execute: (request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> => adapter.execute(request),
    receive: async (envelope: HandoffEnvelope): Promise<void> => {
      probe(envelope);
      await adapter.receive(envelope);
    },
    complete: (handoffId: string): Promise<void> => adapter.complete(handoffId),
    status: (handoffId: string): HandoffStatus => adapter.status(handoffId),
  };
}

function evidenceFor(request: EnvironmentExecutionRequest, evidenceId: string, passed: boolean): VerificationEvidence {
  const decision = request.state.routingDecision;
  if (decision === null) throw new InvalidTaskStateError("Execution requires a routing decision");
  return {
    evidenceId,
    stage: "verify",
    environment: request.state.environment,
    role: "evidence-collector",
    selectedModel: decision.selectedModel,
    command: "fixture execution",
    observedOutput: passed ? "fixture passed" : "fixture failed",
    exitCode: passed ? 0 : 1,
    interpretation: passed ? "Execution completed" : "Execution failed",
    passed,
    recoveryPointId: null,
    recordedAt: "2026-08-21T00:00:00.000Z",
  };
}

function completedExecution(request: EnvironmentExecutionRequest): EnvironmentExecutionResult {
  return {
    status: "completed",
    evidence: executionGateNames.map((gate) => evidenceFor(request, `gate:${gate}`, true)),
    message: "execution completed",
  };
}

function genericCompletedExecution(request: EnvironmentExecutionRequest): EnvironmentExecutionResult {
  return {
    status: "completed",
    evidence: [evidenceFor(request, "execution:passed", true)],
    message: "execution completed",
  };
}

function failedExecution(request: EnvironmentExecutionRequest): EnvironmentExecutionResult {
  return {
    status: "failed",
    evidence: [evidenceFor(request, "execution:failed", false)],
    message: "execution did not complete",
  };
}

function successfulRollbackResult(): RollbackResult {
  return {
    preservedUserWork: {
      archiveId: "archive-1",
      patchDigest: "a".repeat(64),
    },
    actions: [{
      command: "git",
      arguments: ["apply"],
      stdout: "applied",
      stderr: "",
      exitCode: 0,
    }],
    verification: {
      passed: true,
      observedOutput: "recovery point verified",
      reason: "recovery point matches",
    },
  };
}

function secretExecution(request: EnvironmentExecutionRequest): EnvironmentExecutionResult {
  return {
    status: "completed",
    evidence: executionGateNames.map((gate) => ({
      ...evidenceFor(request, `gate:${gate}`, true),
      command: "npm test token=evidence-command-secret",
      observedOutput: "authorization: Bearer evidence-output-secret",
      interpretation: "password=evidence-interpretation-secret",
    })),
    message: "execution completed apiKey=execution-message-secret",
  };
}

function passingGates(input: HardGateInput): readonly GateResult[] {
  return ["scope", "environment-capability", "task-state", "quality", "failure-handling", "recovery", "durable-context", "critical-unsaved-context"].map((gate) => ({
    gate,
    passed: true,
    observedOutput: input.state.verificationEvidence[0]?.observedOutput ?? "passed",
    exitCode: 0,
    reason: "passed",
  }));
}

function failedRecoveryGates(input: HardGateInput): readonly GateResult[] {
  return passingGates(input).map((result) => result.gate === "recovery"
    ? { ...result, passed: false, exitCode: 1, reason: "recovery verification failed" }
    : result);
}

function blockedGates(input: HardGateInput): readonly GateResult[] {
  return passingGates(input).map((result) => result.gate === "quality"
    ? { ...result, passed: false, exitCode: 1, reason: "quality verification failed" }
    : result);
}

function omittedGates(input: HardGateInput): readonly GateResult[] {
  return passingGates(input).filter((result) => result.gate === "quality");
}

function closeVerdict(state: TaskState, status: CloseVerdict["status"]): CloseVerdict {
  const closeCandidate: CloseCandidate | null = status === "YES" && state.durableContext !== null
    ? {
      taskId: state.taskId,
      durableContext: state.durableContext,
      contextManifest: [...state.contextManifest],
      repositoryPath: "C:/repo",
      remote: "origin",
      ref: "refs/heads/main",
      commitSha: "e".repeat(40),
      criticalUnsavedContext: [...state.criticalUnsavedContext],
      recordedAt: "2026-08-21T00:01:00.000Z",
    }
    : null;
  return {
    taskId: state.taskId,
    status,
    stage: state.stage,
    environment: state.environment,
    role: state.role,
    selectedModel: state.routingDecision?.selectedModel ?? "model",
    evidence: state.verificationEvidence,
    recoveryPoint: state.recoveryPoint,
    durablePaths: state.durableContext?.durablePaths ?? [],
    hashes: state.durableContext?.hashes ?? {},
    closeCandidate,
    reasons: status === "YES" ? [] : [`close returned ${status}`],
  };
}

function harness(
  executionResult: ExecutionResultFactory,
  evaluateGates: (input: HardGateInput) => readonly GateResult[],
  closeStatus: CloseVerdict["status"],
): RuntimeHarness {
  const savedStates: TaskState[] = [];
  const closedStates: TaskState[] = [];
  const store = memoryStore(savedStates, "state.json");
  const handoffService = new PersistentHandoffService(new InMemoryHandoffPersistence());
  const executed: EnvironmentExecutionRequest[] = [];
  const loadedSkills: string[] = [];
  const recoveredReasons: string[] = [];
  const executor = async (request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> => {
    executed.push(request);
    return executionResult(request);
  };
  const adapters: Readonly<Record<Environment, DAIEnvironmentAdapter>> = {
    chat: new ChatEnvironmentAdapter(handoffService, executor),
    work: new WorkEnvironmentAdapter(handoffService, executor),
    codex: new CodexEnvironmentAdapter(handoffService, executor),
  };
  const dependencies: DAIRuntimeDependencies = {
    store,
    workspacePath,
    repositoryPath: null,
    skillRoots: [skillRoot],
    modelPolicies: policies,
    adapters,
    handoffService,
    bootstrapTask,
    selectEnvironment,
    resolveModelRoute,
    discoverSkillMetadata,
    selectCapabilities,
    loadSelectedSkill: async (descriptor, requiredResources) => {
      loadedSkills.push(descriptor.name);
      return loadSelectedSkill(descriptor, requiredResources);
    },
    evaluateHardGates: evaluateGates,
    createDebugSession,
    captureRecoveryPoint: async (state) => {
      const manifest = state.durableContext;
      if (manifest === null) throw new InvalidTaskStateError("Recovery capture requires durable context");
      return {
        recoveryPointId: `recovery-${state.taskId}`,
        taskId: state.taskId,
        stage: state.stage,
        environment: state.environment,
        role: state.role,
        durablePaths: manifest.durablePaths,
        hashes: manifest.hashes,
        restorationInstructions: "Restore the persisted runtime state without deleting user work.",
        createdAt: "2026-08-21T00:00:00.000Z",
      };
    },
    recover: async (state, reason): Promise<TaskState> => {
      recoveredReasons.push(reason);
      return { ...state, stage: "recover", role: "recovery-operator" };
    },
    rollbackTask: async (): Promise<RollbackResult> => successfulRollbackResult(),
    closeTask: async (state): Promise<CloseVerdict> => {
      closedStates.push(state);
      return closeVerdict(state, closeStatus);
    },
    maximumEvidenceAgeMs: 300_000,
    now: (): Date => new Date("2026-08-21T00:01:00.000Z"),
  };
  return { dependencies, executed, loadedSkills, recoveredReasons, savedStates, closedStates, handoffService, store };
}

function intentRequest(sourceEnvironment: Environment, overrides: DAIRequest["overrides"]): DAIRequest {
  return {
    command: parseDAICommand("@D-AI implement typescript"),
    sourceEnvironment,
    overrides,
  };
}

const noOverrides: DAIRequest["overrides"] = { model: null, role: null, environment: null };

const stageMatrixPolicies: readonly ModelPolicy[] = [
  ...policies,
  { stage: "execute", role: "implementer", model: "work-model", requiredCapabilities: ["durable-context"], compatibleEnvironments: ["work"] },
  { stage: "route", role: "planner", model: "chat-router", requiredCapabilities: [], compatibleEnvironments: ["chat"] },
  { stage: "plan", role: "planner", model: "work-planner", requiredCapabilities: ["durable-context"], compatibleEnvironments: ["work"] },
  { stage: "plan", role: "planner", model: "chat-planner", requiredCapabilities: ["approval"], compatibleEnvironments: ["chat"] },
  { stage: "verify", role: "reviewer", model: "work-reviewer", requiredCapabilities: ["durable-context"], compatibleEnvironments: ["work"] },
  { stage: "verify", role: "reviewer", model: "codex-reviewer", requiredCapabilities: ["codex-evidence"], compatibleEnvironments: ["codex"] },
];

describe("D-AI runtime", () => {
  it("fails closed when exact gate:<name> evidence is missing", async () => {
    const runtimeHarness = harness(genericCompletedExecution, evaluateHardGates, "YES");

    const result = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/missing evidence for scope gate/i);
  });

  it("fails missing exact gate evidence even when an injected evaluator reports passes", async () => {
    const runtimeHarness = harness(genericCompletedExecution, passingGates, "YES");

    const result = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/missing evidence for scope gate/i);
  });

  it("persists every forward lifecycle stage through verify", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");

    await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(runtimeHarness.savedStates.map((state) => state.stage)).toEqual(expect.arrayContaining([
      "bootstrap",
      "route",
      "plan",
      "execute",
      "inspect",
      "verify",
    ]));
  });

  it("keeps only the routed environment as the authoritative task owner", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    await handle(intentRequest("chat", noOverrides));

    const staleOwner = await handle({ command: { kind: "status" }, sourceEnvironment: "chat", overrides: noOverrides });
    const currentOwner = await handle({ command: { kind: "status" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(staleOwner.status).toBe("blocked");
    expect(currentOwner.status).toBe("accepted");
  });

  it.each(["chat", "work", "codex"] as const)("normalizes equivalent intent from %s and executes in the routed environment", async (sourceEnvironment) => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);

    const response = await handle(intentRequest(sourceEnvironment, noOverrides));

    expect(response.status).toBe("completed");
    expect(response.environment).toBe("codex");
    expect(runtimeHarness.executed).toHaveLength(1);
    expect(runtimeHarness.executed[0]?.state.goal).toBe("implement typescript");
  });

  it.each([
    ["route", "chat", "chat-router", "blocked"],
    ["plan", "work", "work-planner", "completed"],
    ["execute", "codex", "codex-model", "completed"],
    ["verify", "work", "work-reviewer", "completed"],
  ] as const)("routes an ordinary intent through the requested %s stage matrix", async (stage, environment, model, status) => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, modelPolicies: stageMatrixPolicies });

    const response = await handle(intentRequest("chat", { model: null, role: null, environment: null, stage }));

    expect(response.status).toBe(status);
    expect(response.environment).toBe(environment);
    expect(runtimeHarness.executed[0]?.state.routingDecision).toMatchObject({
      stage: "execute",
      requestedStage: stage,
      environment,
      selectedModel: model,
    });
    const reloaded = await runtimeHarness.store.load(response.taskId);
    expect(reloaded).toMatchObject({
      taskId: response.taskId,
      routingDecision: { requestedStage: stage },
    });
    if (status === "completed") {
      expect(reloaded).toMatchObject({
        stage: "verify",
        routingDecision: {
          stage: "verify",
          requestedStage: stage,
          environment,
          selectedModel: model,
        },
      });
    }
  });

  it.each([
    {
      label: "Codex to Chat plan",
      sourceEnvironment: "codex",
      stage: "plan",
      environment: "chat",
      model: "chat-planner",
      skill: "unrelated-planning",
      overrides: { model: null, role: null, environment: "chat", stage: "plan" },
      request: (overrides: DAIRequest["overrides"]): DAIRequest => ({
        ...intentRequest("codex", overrides),
        command: parseDAICommand("@D-AI plan campaign"),
      }),
    },
    {
      label: "Chat to Work execute",
      sourceEnvironment: "chat",
      stage: "execute",
      environment: "work",
      model: "work-model",
      skill: "typescript-execution",
      overrides: { model: null, role: null, environment: "work", stage: "execute" },
      request: (overrides: DAIRequest["overrides"]): DAIRequest => intentRequest("chat", overrides),
    },
    {
      label: "Work to Codex execute",
      sourceEnvironment: "work",
      stage: "execute",
      environment: "codex",
      model: "codex-model",
      skill: "typescript-execution",
      overrides: { model: null, role: null, environment: "codex", stage: "execute" },
      request: (overrides: DAIRequest["overrides"]): DAIRequest => intentRequest("work", overrides),
    },
    {
      label: "Codex to Codex verify",
      sourceEnvironment: "codex",
      stage: "verify",
      environment: "codex",
      model: "codex-reviewer",
      skill: "verification-execution",
      overrides: { model: null, role: null, environment: "codex", stage: "verify" },
      request: (overrides: DAIRequest["overrides"]): DAIRequest => ({
        ...intentRequest("codex", overrides),
        command: parseDAICommand("@D-AI verify evidence"),
      }),
    },
  ] as const)("routes explicit $label through the requested policy and compatible Skill", async ({
    sourceEnvironment,
    stage,
    environment,
    model,
    skill,
    overrides,
    request,
  }) => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, modelPolicies: stageMatrixPolicies });

    const response = await handle(request(overrides));

    expect(response.status).toBe("completed");
    expect(response.environment).toBe(environment);
    expect(runtimeHarness.executed[0]?.state.environment).toBe(environment);
    expect(runtimeHarness.executed[0]?.state.routingDecision).toMatchObject({
      stage: "execute",
      requestedStage: stage,
      environment,
      selectedModel: model,
    });
    expect(runtimeHarness.executed[0]?.skills.map((selectedSkill) => selectedSkill.descriptor.name)).toEqual([skill]);
    expect(runtimeHarness.executed[0]?.skills[0]?.descriptor.compatibleEnvironments).toContain(environment);
    expect(runtimeHarness.executed[0]?.skills[0]?.descriptor.compatibleStages).toContain(stage);
    expect((await handle({ command: { kind: "status" }, sourceEnvironment: environment, overrides: noOverrides })).status).toBe("accepted");
    if (sourceEnvironment !== environment) {
      expect((await handle({ command: { kind: "status" }, sourceEnvironment, overrides: noOverrides })).status).toBe("blocked");
    }
  });

  it("preserves requestedStage in the final durable verify state and serialized handoff target", async () => {
    const durableRoot = await mkdtemp(join(tmpdir(), "d-ai-routing-review-"));
    const runtimeHarness = harness((request) => {
      const result = completedExecution(request);
      const recordedAt = new Date().toISOString();
      return { ...result, evidence: result.evidence.map((evidence) => ({ ...evidence, recordedAt })) };
    }, evaluateHardGates, "YES");
    const store = new FileDurableContextStore(durableRoot);
    const receivedEnvelopes: HandoffEnvelope[] = [];
    const adapters: Readonly<Record<Environment, DAIEnvironmentAdapter>> = {
      ...runtimeHarness.dependencies.adapters,
      work: adapterWithReceiveProbe(runtimeHarness.dependencies.adapters.work, (envelope) => { receivedEnvelopes.push(envelope); }),
    };
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store,
      adapters,
      modelPolicies: stageMatrixPolicies,
      now: (): Date => new Date(),
    });

    try {
      const accepted = await handle(intentRequest("codex", { model: null, role: null, environment: "chat", stage: "plan" }));
      expect(accepted.status).toBe("completed");

      const handoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "chat", overrides: noOverrides });
      expect(handoff).toMatchObject({ taskId: accepted.taskId, stage: "handoff", environment: "work", status: "accepted" });
      expect(receivedEnvelopes).toHaveLength(1);
      expect(receivedEnvelopes[0]).toMatchObject({
        taskId: accepted.taskId,
        sourceEnvironment: "chat",
        targetEnvironment: "work",
        stage: "verify",
        taskState: {
          stage: "verify",
          environment: "chat",
          routingDecision: {
            stage: "verify",
            requestedStage: "plan",
            environment: "chat",
            selectedModel: "chat-planner",
          },
        },
      });

      const handoffId = /^Handoff (handoff-\S+) is owned/.exec(handoff.message)?.[1];
      if (handoffId === undefined) throw new InvalidTaskStateError("Handoff response did not include its id");
      expect(runtimeHarness.handoffService.status(handoffId)).toMatchObject({ target: "work", state: "active", owner: "work" });
      const completed = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
      expect(completed).toMatchObject({ taskId: accepted.taskId, stage: "verify", environment: "work", status: "completed" });

      const finalState = await store.load(accepted.taskId);
      const reloadedState = await new FileDurableContextStore(durableRoot).load(accepted.taskId);
      expect(reloadedState).toEqual(finalState);
      expect(finalState).toMatchObject({
        taskId: accepted.taskId,
        stage: "verify",
        environment: "work",
        role: "evidence-collector",
        handoffState: "completed",
        routingDecision: {
          stage: "verify",
          requestedStage: "plan",
          environment: "work",
          role: "evidence-collector",
          selectedModel: "chat-planner",
        },
        durableContext: {
          stage: "verify",
          environment: "work",
          role: "evidence-collector",
        },
      });
      expect(finalState?.routingDecision?.requestedStage).toBe("plan");
    } finally {
      await rm(durableRoot, { recursive: true, force: true });
    }
  });

  it("honors routing overrides and loads only the minimum selected Skill", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);

    const response = await handle(intentRequest("chat", { model: "codex-model", role: "implementer", environment: "codex" }));

    expect(response.status).toBe("completed");
    expect(runtimeHarness.loadedSkills).toEqual(["typescript-execution"]);
    expect(runtimeHarness.executed[0]?.skills.map((skill) => skill.descriptor.name)).toEqual(["typescript-execution"]);
    expect(runtimeHarness.executed[0]?.state.routingDecision).toMatchObject({
      selectedModel: "codex-model",
      environment: "codex",
      overrideSource: "user",
    });
  });

  it("transfers durable ownership before executing in the routed environment", async () => {
    const executionEvents: string[] = [];
    const runtimeHarness = harness((request) => {
      executionEvents.push(`execute:${request.state.environment}`);
      return completedExecution(request);
    }, evaluateHardGates, "YES");
    const baseStore = memoryStore(runtimeHarness.savedStates, "state.json");
    const events: string[] = [];
    const store: DurableContextStore = {
      ...baseStore,
      withTaskOwnership: <T>(
        taskId: string,
        environment: Environment,
        operation: (
          lease: TaskOwnershipLease,
          transfer: TaskOwnershipTransfer,
          assertOwnership: TaskOwnershipGuard,
          authorizeTransition: TaskOwnershipTransitionAuthorizer,
        ) => Promise<T>,
      ) => baseStore.withTaskOwnership!(
        taskId,
        environment,
        (lease, transfer, assertOwnership, authorizeTransition) => operation(
          lease,
          async (targetEnvironment: Environment): Promise<TaskOwnershipLease> => {
            events.push(`transfer:start:${targetEnvironment}`);
            const targetLease = await transfer(targetEnvironment);
            events.push(`transfer:complete:${targetEnvironment}`);
            return targetLease;
          },
          assertOwnership,
          (targetEnvironment: Environment) => {
            events.push(`transition:${targetEnvironment}`);
            return authorizeTransition(targetEnvironment);
          },
        ),
      ),
    };
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store,
    });

    const response = await handle(intentRequest("chat", noOverrides));

    expect(response.status, response.message).toBe("completed");
    expect(events).toEqual([
      "transfer:start:codex",
      "transfer:complete:codex",
    ]);
    expect(executionEvents).toEqual(["execute:codex"]);
  });

  it("does not persist routed state or execute when durable ownership transfer fails", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const baseStore = runtimeHarness.store;
    const store: DurableContextStore = {
      ...baseStore,
      withTaskOwnership: <T>(
        taskId: string,
        environment: Environment,
        operation: (
          lease: TaskOwnershipLease,
          transfer: TaskOwnershipTransfer,
          assertOwnership: TaskOwnershipGuard,
          authorizeTransition: TaskOwnershipTransitionAuthorizer,
        ) => Promise<T>,
      ) => baseStore.withTaskOwnership!(taskId, environment, (lease, _transfer, assertOwnership, authorizeTransition) => operation(
        lease,
        async () => { throw new TaskOwnershipError("transfer failed"); },
        assertOwnership,
        authorizeTransition,
      )),
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, store });

    const response = await handle(intentRequest("chat", noOverrides));
    const persisted = await baseStore.load(response.taskId);

    expect(response).toMatchObject({ status: "blocked", taskId: expect.any(String) });
    expect(persisted).toMatchObject({ stage: "bootstrap", environment: "chat" });
    expect(runtimeHarness.executed).toHaveLength(0);
  });

  it("preserves the task id and transfers single ownership through the existing handoff service", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("chat", noOverrides));

    const response = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(response.taskId).toBe(accepted.taskId);
    expect(response.stage).toBe("handoff");
    expect(response.environment).toBe("work");
    const persisted = await runtimeHarness.store.load(response.taskId);
    expect(persisted).toMatchObject({ taskId: accepted.taskId, environment: "work", handoffState: "active" });
    expect(persisted?.verificationEvidence).toEqual(accepted.evidence);
    const handoffId = /^Handoff (handoff-\S+) is owned/.exec(response.message)?.[1];
    if (handoffId === undefined) throw new InvalidTaskStateError("Handoff response did not include its id");
    expect(runtimeHarness.handoffService.status(handoffId)).toMatchObject({ owner: "work", state: "active" });

    const repeated = await handle({ command: { kind: "handoff", target: "chat" }, sourceEnvironment: "work", overrides: noOverrides });
    expect(repeated.status).toBe("blocked");
  });

  it("completes the real active handoff and persists the same Work-owned task at verify", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("chat", noOverrides));
    const handoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const handoffId = /^Handoff (handoff-\S+) is owned/.exec(handoff.message)?.[1];
    if (handoffId === undefined) throw new InvalidTaskStateError("Handoff response did not include its id");

    const completed = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });

    expect(completed).toMatchObject({ taskId: accepted.taskId, stage: "verify", environment: "work", status: "completed" });
    expect(await runtimeHarness.store.load(accepted.taskId)).toMatchObject({
      taskId: accepted.taskId,
      stage: "verify",
      environment: "work",
      handoffState: "completed",
    });
    expect(runtimeHarness.handoffService.status(handoffId)).toMatchObject({ state: "completed", owner: "work" });
  });

  it("blocks handoff completion when the source is not the durable target owner", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("chat", noOverrides));
    const handoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const handoffId = /^Handoff (handoff-\S+) is owned/.exec(handoff.message)?.[1];
    if (handoffId === undefined) throw new InvalidTaskStateError("Handoff response did not include its id");

    const blocked = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(blocked).toMatchObject({ taskId: "unassigned", stage: "bootstrap", status: "blocked" });
    expect(await runtimeHarness.handoffService.status(handoffId)).toMatchObject({ state: "active", owner: "work" });
  });

  it("rejects a handoff id belonging to another active task before changing either record", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("chat", noOverrides));
    const firstHandoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const firstId = /^Handoff (handoff-\S+) is owned/.exec(firstHandoff.message)?.[1];
    if (firstId === undefined) throw new InvalidTaskStateError("First handoff id was not recorded");

    const secondState = {
      ...await runtimeHarness.store.load(accepted.taskId) as TaskState,
      taskId: "task-other",
      environment: "codex" as const,
      routingDecision: null,
      handoffState: "none" as const,
      verificationEvidence: [],
      recoveryPoint: null,
      durableContext: null,
    };
    const secondEnvelope = await runtimeHarness.handoffService.create({ state: secondState, targetEnvironment: "work" });
    await new WorkEnvironmentAdapter(runtimeHarness.handoffService).receive(secondEnvelope);
    const beforeFirst = runtimeHarness.handoffService.status(firstId);
    const beforeSecond = runtimeHarness.handoffService.status(secondEnvelope.handoffId);

    const blocked = await handle({ command: { kind: "complete", handoffId: secondEnvelope.handoffId }, sourceEnvironment: "work", overrides: noOverrides });

    expect(blocked.status).toBe("blocked");
    expect(runtimeHarness.handoffService.status(firstId)).toEqual(beforeFirst);
    expect(runtimeHarness.handoffService.status(secondEnvelope.handoffId)).toEqual(beforeSecond);
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ taskId: accepted.taskId, stage: "handoff", handoffState: "active" });
  });

  it("reconciles a completed service handoff after task persistence fails", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let failCompletionSave = true;
    const failingStore: DurableContextStore = {
      load: (taskId) => runtimeHarness.store.load(taskId),
      save: async (state) => {
        if (failCompletionSave && state.handoffState === "completed") {
          failCompletionSave = false;
          throw new InvalidTaskStateError("completion task save failed");
        }
        return runtimeHarness.store.save(state);
      },
      recordCriticalUnsavedContext: (taskId, items) => runtimeHarness.store.recordCriticalUnsavedContext(taskId, items),
      clearCriticalUnsavedContext: (taskId) => runtimeHarness.store.clearCriticalUnsavedContext(taskId),
      withTaskOwnership: inMemoryTaskOwnership,
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, store: failingStore });
    const accepted = await handle(intentRequest("chat", noOverrides));
    const handoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const handoffId = /^Handoff (handoff-\S+) is owned/.exec(handoff.message)?.[1];
    if (handoffId === undefined) throw new InvalidTaskStateError("Handoff id was not recorded");

    const firstAttempt = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
    expect(firstAttempt.status).toBe("blocked");
    expect(await runtimeHarness.store.load(accepted.taskId)).toMatchObject({ stage: "handoff", handoffState: "active" });
    expect(runtimeHarness.handoffService.status(handoffId)).toMatchObject({ state: "completed", owner: "work", taskId: accepted.taskId, target: "work" });

    const retry = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
    expect(retry).toMatchObject({ taskId: accepted.taskId, stage: "verify", status: "completed" });
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "verify", handoffState: "completed" });
  });

  it("retries recovery capture after the handoff service has completed", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const originalCapture = runtimeHarness.dependencies.captureRecoveryPoint;
    let captureAttempts = 0;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      captureRecoveryPoint: async (state): Promise<RecoveryPoint | CapturedRecoveryPoint> => {
        captureAttempts += 1;
        if (captureAttempts === 2) throw new InvalidTaskStateError("recovery capture failed once");
        return originalCapture(state);
      },
    });
    const accepted = await handle(intentRequest("chat", noOverrides));
    const handoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const handoffId = /^Handoff (handoff-\S+) is owned/.exec(handoff.message)?.[1];
    if (handoffId === undefined) throw new InvalidTaskStateError("Handoff id was not recorded");

    const firstAttempt = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
    expect(firstAttempt.status).toBe("blocked");
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "verify", handoffState: "completed", recoveryPoint: { recoveryPointId: expect.any(String) } });

    const retry = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
    expect(retry).toMatchObject({ taskId: accepted.taskId, stage: "verify", status: "completed" });
    expect(captureAttempts).toBe(3);
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "verify", handoffState: "completed", recoveryPoint: { recoveryPointId: expect.any(String) } });
  });

  it("retries recovery capture and final persistence after the final save fails", async () => {
    const executionWithIdentity = (request: EnvironmentExecutionRequest): EnvironmentExecutionResult => ({
      ...completedExecution(request),
      contextManifestEntries: [
        "branch:main",
        "remote:origin",
        "ref:refs/heads/main",
        `artifact:commit:${"a".repeat(40)}`,
        "local-state:clean-required",
        "remote-repository:github.com/acme/d-ai",
      ],
    });
    const runtimeHarness = harness(executionWithIdentity, evaluateHardGates, "YES");
    let recoverySaveAttempts = 0;
    const failingStore: DurableContextStore = {
      load: (taskId) => runtimeHarness.store.load(taskId),
      save: async (state) => {
        if (state.stage === "verify" && state.handoffState === "completed" && state.recoveryPoint !== null) {
          recoverySaveAttempts += 1;
        }
        if (recoverySaveAttempts === 2) {
          throw new InvalidTaskStateError("final recovery save failed once");
        }
        return runtimeHarness.store.save(state);
      },
      recordCriticalUnsavedContext: (taskId, items) => runtimeHarness.store.recordCriticalUnsavedContext(taskId, items),
      clearCriticalUnsavedContext: (taskId) => runtimeHarness.store.clearCriticalUnsavedContext(taskId),
      withTaskOwnership: inMemoryTaskOwnership,
    };
    const captureAttempts: TaskState[] = [];
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store: failingStore,
      captureRecoveryPoint: async (state): Promise<RecoveryPoint | CapturedRecoveryPoint> => {
        captureAttempts.push(state);
        return runtimeHarness.dependencies.captureRecoveryPoint(state);
      },
    });
    const accepted = await handle(intentRequest("chat", noOverrides));
    const handoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const handoffId = /^Handoff (handoff-\S+) is owned/.exec(handoff.message)?.[1];
    if (handoffId === undefined) throw new InvalidTaskStateError("Handoff id was not recorded");

    const firstAttempt = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
    expect(firstAttempt.status).toBe("blocked");
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "verify", handoffState: "completed", recoveryPoint: { recoveryPointId: expect.any(String) } });

    const retry = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
    expect(retry).toMatchObject({ taskId: accepted.taskId, stage: "verify", status: "completed" });
    expect(captureAttempts).toHaveLength(3);
    const recovered = await runtimeHarness.store.load(accepted.taskId);
    expect(recovered).toMatchObject({ stage: "verify", handoffState: "completed", recoveryPoint: { recoveryPointId: expect.any(String) } });
    if (recovered === null) throw new InvalidTaskStateError("Expected recovered task state");
    for (const prefix of ["branch:", "remote:", "ref:", "artifact:commit:", "local-state:"] as const) {
      expect(recovered.contextManifest.filter((entry) => entry.startsWith(prefix))).toHaveLength(1);
    }
    await expect(handle({ command: { kind: "close" }, sourceEnvironment: "work", overrides: noOverrides })).resolves.toMatchObject({
      taskId: accepted.taskId,
      stage: "close",
      status: "completed",
    });
  });

  it("blocks conflicting execution identity facts before persisting an ambiguous manifest", async () => {
    const runtimeHarness = harness((request) => ({
      ...completedExecution(request),
      contextManifestEntries: [
        "branch:main",
        "branch:other",
        "remote:origin",
        "ref:refs/heads/main",
        `artifact:commit:${"a".repeat(40)}`,
        "local-state:clean-required",
        "remote-repository:github.com/acme/d-ai",
      ],
    }), evaluateHardGates, "YES");

    const result = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/identity facts|conflicting|duplicate/i);
  });

  it.each([
    ["malformed branch path", "branch:feature//bad"],
    ["parent branch path", "branch:feature/.."],
    ["trailing branch slash", "branch:feature/"],
    ["malformed ref path", "ref:refs/heads/feature//bad"],
    ["parent ref path", "ref:refs/heads/feature/.."],
    ["ambiguous numeric artifact", `artifact:commit:${"1".repeat(41)}`],
    ["ambiguous long numeric artifact", `artifact:commit:${"2".repeat(63)}`],
  ] as const)("rejects %s at the execution identity seam", async (_label, invalidEntry) => {
    const runtimeHarness = harness((request) => ({
      ...completedExecution(request),
      contextManifestEntries: [
        "branch:main",
        "remote:origin",
        "ref:refs/heads/main",
        `artifact:commit:${"a".repeat(40)}`,
        "local-state:clean-required",
        "remote-repository:github.com/acme/d-ai",
      ].filter((entry) => {
        const prefix = invalidEntry.startsWith("artifact:commit:") ? "artifact:commit:"
          : invalidEntry.startsWith("ref:") ? "ref:"
            : "branch:";
        return !entry.startsWith(prefix);
      }).concat(invalidEntry),
    }), evaluateHardGates, "YES");

    const result = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("codex", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/identity|approved|malformed|conflicting/i);
  });

  it.each(["a".repeat(40), "b".repeat(64)] as const)("retains supported %s-character hexadecimal artifacts", async (artifact) => {
    const runtimeHarness = harness((request) => ({
      ...completedExecution(request),
      contextManifestEntries: [
        "branch:main",
        "remote:origin",
        "ref:refs/heads/main",
        `artifact:commit:${artifact}`,
        "local-state:clean-required",
        "remote-repository:github.com/acme/d-ai",
      ],
    }), evaluateHardGates, "YES");

    await expect(createDAIRuntime(runtimeHarness.dependencies)(intentRequest("codex", noOverrides))).resolves.toMatchObject({ status: "completed" });
  });

  it("leaves the task retryable when the handoff service completion fails", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let failCompletion = true;
    const handoffService: HandoffService = {
      ready: () => runtimeHarness.handoffService.ready(),
      create: (input) => runtimeHarness.handoffService.create(input),
      recordsForTask: (taskId) => runtimeHarness.handoffService.recordsForTask(taskId),
      acknowledge: (envelope, target) => runtimeHarness.handoffService.acknowledge(envelope, target),
      complete: async () => {
        if (failCompletion) {
          failCompletion = false;
          throw new InvalidTaskStateError("service completion failed");
        }
        return Promise.resolve();
      },
      reject: (handoffId, reason) => runtimeHarness.handoffService.reject(handoffId, reason),
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, handoffService });
    const accepted = await handle(intentRequest("chat", noOverrides));
    const handoff = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const handoffId = /^Handoff (handoff-\S+) is owned/.exec(handoff.message)?.[1];
    if (handoffId === undefined) throw new InvalidTaskStateError("Handoff id was not recorded");

    const failed = await handle({ command: { kind: "complete", handoffId }, sourceEnvironment: "work", overrides: noOverrides });
    expect(failed.status).toBe("blocked");
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "handoff", handoffState: "active" });
    expect(runtimeHarness.handoffService.status(handoffId)).toMatchObject({ state: "active", owner: "work" });
  });

  it("uses the durable environment to reject stale continuation in a fresh runtime", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const seedingRuntime = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await seedingRuntime(intentRequest("chat", noOverrides));
    await seedingRuntime({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    const freshRuntime = createDAIRuntime(runtimeHarness.dependencies);

    const staleContinuation = await freshRuntime({
      command: { kind: "continue", taskIdOrProject: accepted.taskId },
      sourceEnvironment: "codex",
      overrides: noOverrides,
    });
    const ownerContinuation = await freshRuntime({
      command: { kind: "continue", taskIdOrProject: accepted.taskId },
      sourceEnvironment: "work",
      overrides: noOverrides,
    });

    expect(staleContinuation.status).toBe("blocked");
    expect(ownerContinuation.status).toBe("accepted");
  });

  it("blocks a second runtime from continuing while the first holds durable task ownership", async () => {
    const durableRoot = await mkdtemp(join(tmpdir(), "d-ai-runtime-ownership-"));
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const firstStore = new FileDurableContextStore(durableRoot);
    const secondStore = new FileDurableContextStore(durableRoot);
    let releaseFirstExecution: () => void = () => {};
    let markFirstExecutionStarted: () => void = () => {};
    let delayNextExecution = false;
    const firstExecutionStarted = new Promise<void>((resolve) => { markFirstExecutionStarted = resolve; });
    const firstExecutionRelease = new Promise<void>((resolve) => { releaseFirstExecution = resolve; });
    const adapters: Readonly<Record<Environment, DAIEnvironmentAdapter>> = {
      ...runtimeHarness.dependencies.adapters,
      codex: {
        capabilities: (): EnvironmentCapabilities => runtimeHarness.dependencies.adapters.codex.capabilities(),
        execute: async (request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> => {
          if (delayNextExecution) {
            delayNextExecution = false;
            markFirstExecutionStarted();
            await firstExecutionRelease;
          }
          return completedExecution(request);
        },
        receive: (envelope: HandoffEnvelope): Promise<void> => runtimeHarness.dependencies.adapters.codex.receive(envelope),
        complete: (handoffId: string): Promise<void> => runtimeHarness.dependencies.adapters.codex.complete(handoffId),
        status: (handoffId: string): HandoffStatus => runtimeHarness.dependencies.adapters.codex.status(handoffId),
      },
    };

    try {
      const seedRuntime = createDAIRuntime({ ...runtimeHarness.dependencies, store: firstStore, adapters });
      const accepted = await seedRuntime(intentRequest("codex", noOverrides));
      const durableState = await firstStore.load(accepted.taskId);
      if (durableState === null) throw new InvalidTaskStateError("Expected a durable task state");
      await firstStore.withTaskOwnership(accepted.taskId, durableState.environment, async (lease) => {
        await firstStore.save({ ...durableState, stage: "recover", role: "recovery-operator", durableContext: null }, lease);
      });
      delayNextExecution = true;

      const firstRuntime = createDAIRuntime({ ...runtimeHarness.dependencies, store: firstStore, adapters });
      const secondRuntime = createDAIRuntime({ ...runtimeHarness.dependencies, store: secondStore, adapters });
      const first = firstRuntime({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides });
      await firstExecutionStarted;

      const second = await secondRuntime({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides });
      expect(second).toMatchObject({ status: "blocked", taskId: accepted.taskId });
      expect(second.message).toMatch(/actively owned/i);

      releaseFirstExecution();
      await first;
    } finally {
      await rm(durableRoot, { recursive: true, force: true });
    }
  });

  it("blocks initial intent and close while another runtime holds the lease, then permits continue and handoff", async () => {
    const durableRoot = await mkdtemp(join(tmpdir(), "d-ai-runtime-lifecycle-ownership-"));
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const firstStore = new FileDurableContextStore(durableRoot);
    const secondStore = new FileDurableContextStore(durableRoot);
    const observedStore = observeFileStoreOwnership(firstStore);
    const firstRuntime = createDAIRuntime({ ...runtimeHarness.dependencies, store: observedStore.store });
    let releaseLease: () => void = () => {};
    let markLeaseActive: () => void = () => {};
    const leaseActive = new Promise<void>((resolve) => { markLeaseActive = resolve; });
    const leaseRelease = new Promise<void>((resolve) => { releaseLease = resolve; });

    try {
      const accepted = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("codex", noOverrides));
      const seedState = await runtimeHarness.store.load(accepted.taskId);
      if (seedState === null) throw new InvalidTaskStateError("Expected a seeded durable task state");
      await firstStore.save({ ...seedState, durableContext: null });
      await expect(firstRuntime({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides })).resolves.toMatchObject({
        taskId: accepted.taskId,
        status: "accepted",
      });
      const leaseHolder = secondStore.withTaskOwnership(accepted.taskId, "codex", async () => {
        markLeaseActive();
        await leaseRelease;
      });
      await leaseActive;

      await expect(firstRuntime(intentRequest("codex", noOverrides))).resolves.toMatchObject({
        taskId: accepted.taskId,
        status: "blocked",
      });
      await expect(firstRuntime({ command: { kind: "close" }, sourceEnvironment: "codex", overrides: noOverrides })).resolves.toMatchObject({
        taskId: accepted.taskId,
        status: "blocked",
      });

      releaseLease();
      await leaseHolder;

      await expect(firstRuntime({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides })).resolves.toMatchObject({
        taskId: accepted.taskId,
        status: "accepted",
      });
      const handoff = await firstRuntime({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
      expect(handoff).toMatchObject({
        taskId: accepted.taskId,
        stage: "handoff",
        environment: "work",
        status: "accepted",
      });
      await expect(firstStore.load(accepted.taskId)).resolves.toMatchObject({
        environment: "work",
        handoffState: "active",
      });
      expect(observedStore.transitions()).toEqual([]);
      expect(observedStore.transfers()).toEqual(["work"]);
    } finally {
      await rm(durableRoot, { recursive: true, force: true });
    }
  });

  it("serializes handoffs, persists pending before acknowledgement, and blocks source operations", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handoffStates: TaskState["handoffState"][] = [];
    const receivedTargets: Environment[] = [];
    let releaseFirstSave: () => void = () => {};
    let markFirstSaveStarted: () => void = () => {};
    const firstSaveStarted = new Promise<void>((resolve) => { markFirstSaveStarted = resolve; });
    const firstSaveRelease = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    const delayedStore: DurableContextStore = {
      load: (taskId: string): Promise<TaskState | null> => runtimeHarness.store.load(taskId),
      save: async (state: TaskState): Promise<DurableContextManifest> => {
        if (state.stage === "handoff") {
          handoffStates.push(state.handoffState);
          if (handoffStates.length === 1) {
            markFirstSaveStarted();
            await firstSaveRelease;
          }
        }
        return runtimeHarness.store.save(state);
      },
      recordCriticalUnsavedContext: (taskId: string, items: readonly string[]): Promise<void> =>
        runtimeHarness.store.recordCriticalUnsavedContext(taskId, items),
      clearCriticalUnsavedContext: (taskId: string): Promise<void> => runtimeHarness.store.clearCriticalUnsavedContext(taskId),
      withTaskOwnership: inMemoryTaskOwnership,
    };
    const adapters: Readonly<Record<Environment, DAIEnvironmentAdapter>> = {
      chat: adapterWithReceiveProbe(runtimeHarness.dependencies.adapters.chat, () => { receivedTargets.push("chat"); }),
      work: adapterWithReceiveProbe(runtimeHarness.dependencies.adapters.work, () => { receivedTargets.push("work"); }),
      codex: runtimeHarness.dependencies.adapters.codex,
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, store: delayedStore, adapters });
    await handle(intentRequest("chat", noOverrides));

    const firstHandoff = handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    await firstSaveStarted;
    const sourceStatus = await handle({ command: { kind: "status" }, sourceEnvironment: "codex", overrides: noOverrides });
    const secondHandoff = handle({ command: { kind: "handoff", target: "chat" }, sourceEnvironment: "codex", overrides: noOverrides });
    releaseFirstSave();
    const [firstResponse, secondResponse] = await Promise.all([firstHandoff, secondHandoff]);

    expect(handoffStates[0]).toBe("pending");
    expect(receivedTargets).toEqual(["work"]);
    expect(sourceStatus.status).toBe("blocked");
    expect(firstResponse.status).toBe("accepted");
    expect(secondResponse.status).toBe("blocked");
  });

  it("persists pending before the handoff connector creates an envelope", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let stateObservedByCreate: TaskState | null = null;
    const otherRuntimeResponses: DAIResponse[] = [];
    const otherRuntime = createDAIRuntime(runtimeHarness.dependencies);
    const handoffService: HandoffService = {
      create: async (input): Promise<HandoffEnvelope> => {
        stateObservedByCreate = await runtimeHarness.store.load(input.state.taskId);
        otherRuntimeResponses.push(await otherRuntime({
          command: { kind: "continue", taskIdOrProject: input.state.taskId },
          sourceEnvironment: "codex",
          overrides: noOverrides,
        }));
        return runtimeHarness.handoffService.create(input);
      },
      recordsForTask: (taskId): Promise<readonly HandoffPersistenceRecord[]> => runtimeHarness.handoffService.recordsForTask(taskId),
      acknowledge: (envelope, target): Promise<void> => runtimeHarness.handoffService.acknowledge(envelope, target),
      complete: (handoffId, recipient): Promise<void> => runtimeHarness.handoffService.complete(handoffId, recipient),
      reject: (handoffId, reason): Promise<void> => runtimeHarness.handoffService.reject(handoffId, reason),
      ready: (): Promise<void> => runtimeHarness.handoffService.ready(),
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, handoffService });
    await handle(intentRequest("chat", noOverrides));

    const result = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(result.status).toBe("accepted");
    expect(stateObservedByCreate).toMatchObject({ stage: "handoff", handoffState: "pending" });
    expect(otherRuntimeResponses[0]?.status).toBe("blocked");
  });

  it("prevents a delayed handoff load from racing concurrent close and continue mutations", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let delayNextLoad = false;
    let releaseHandoffLoad: () => void = () => {};
    let markHandoffLoadStarted: () => void = () => {};
    const handoffLoadStarted = new Promise<void>((resolve) => { markHandoffLoadStarted = resolve; });
    const handoffLoadRelease = new Promise<void>((resolve) => { releaseHandoffLoad = resolve; });
    const delayedStore: DurableContextStore = {
      load: async (taskId: string): Promise<TaskState | null> => {
        const loaded = await runtimeHarness.store.load(taskId);
        if (delayNextLoad) {
          delayNextLoad = false;
          markHandoffLoadStarted();
          await handoffLoadRelease;
        }
        return loaded;
      },
      save: (state: TaskState): Promise<DurableContextManifest> => runtimeHarness.store.save(state),
      recordCriticalUnsavedContext: (taskId: string, items: readonly string[]): Promise<void> =>
        runtimeHarness.store.recordCriticalUnsavedContext(taskId, items),
      clearCriticalUnsavedContext: (taskId: string): Promise<void> => runtimeHarness.store.clearCriticalUnsavedContext(taskId),
      withTaskOwnership: inMemoryTaskOwnership,
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, store: delayedStore });
    const accepted = await handle(intentRequest("chat", noOverrides));
    delayNextLoad = true;

    const handoff = handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    await handoffLoadStarted;
    const close = handle({ command: { kind: "close" }, sourceEnvironment: "codex", overrides: noOverrides });
    const continuation = handle({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides });
    await Promise.resolve();
    await Promise.resolve();
    releaseHandoffLoad();
    const [handoffResult, closeResult, continueResult] = await Promise.all([handoff, close, continuation]);

    expect(handoffResult.status).toBe("accepted");
    expect(closeResult.status).toBe("blocked");
    expect(continueResult.status).toBe("blocked");
    expect(runtimeHarness.closedStates).toEqual([]);
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({
      environment: "work",
      stage: "handoff",
      handoffState: "active",
    });
  });

  it("rejects an acknowledged handoff when active-state persistence fails and blocks both runtime lanes", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const receivedHandoffIds: string[] = [];
    let failActiveSave = true;
    const failingStore: DurableContextStore = {
      load: (taskId: string): Promise<TaskState | null> => runtimeHarness.store.load(taskId),
      save: async (state: TaskState): Promise<DurableContextManifest> => {
        if (state.stage === "handoff" && state.handoffState === "active" && failActiveSave) {
          failActiveSave = false;
          throw new InvalidTaskStateError("handoff active persistence failed token=handoff-store-secret");
        }
        return runtimeHarness.store.save(state);
      },
      recordCriticalUnsavedContext: (taskId: string, items: readonly string[]): Promise<void> =>
        runtimeHarness.store.recordCriticalUnsavedContext(taskId, items),
      clearCriticalUnsavedContext: (taskId: string): Promise<void> => runtimeHarness.store.clearCriticalUnsavedContext(taskId),
      withTaskOwnership: inMemoryTaskOwnership,
    };
    const adapters: Readonly<Record<Environment, DAIEnvironmentAdapter>> = {
      ...runtimeHarness.dependencies.adapters,
      work: adapterWithReceiveProbe(runtimeHarness.dependencies.adapters.work, (envelope) => { receivedHandoffIds.push(envelope.handoffId); }),
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, store: failingStore, adapters });
    const accepted = await handle(intentRequest("chat", noOverrides));

    const result = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });

    const handoffId = receivedHandoffIds[0];
    if (handoffId === undefined) throw new InvalidTaskStateError("Failing handoff did not reach the target adapter");
    expect(result.status).toBe("blocked");
    expect(result.message).toContain("[REDACTED]");
    expect(result.message).not.toContain("handoff-store-secret");
    expect(runtimeHarness.handoffService.status(handoffId).state).toBe("rejected");
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "handoff", handoffState: "rejected" });
    const sourceStatus = await handle({ command: { kind: "status" }, sourceEnvironment: "codex", overrides: noOverrides });
    const targetStatus = await handle({ command: { kind: "status" }, sourceEnvironment: "work", overrides: noOverrides });
    expect(sourceStatus.status).toBe("blocked");
    expect(targetStatus.status).toBe("blocked");
    expect(runtimeHarness.savedStates.filter((state) => state.stage === "handoff").map((state) => state.handoffState)).toEqual([
      "pending",
      "rejected",
    ]);
  });

  it("does not leave a durable active handoff when ownership transfer fails after target cleanup is unavailable", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const baseStore = runtimeHarness.store;
    const store: DurableContextStore = {
      ...baseStore,
      save: async (state: TaskState, authorization?: TaskOwnershipLease | TaskOwnershipTransition): Promise<DurableContextManifest> => {
        if (state.handoffState === "rejected") throw new InvalidTaskStateError("handoff rejection persistence unavailable");
        return baseStore.save(state, authorization);
      },
      withTaskOwnership: <T>(
        taskId: string,
        environment: Environment,
        operation: (
          lease: TaskOwnershipLease,
          transfer: TaskOwnershipTransfer,
          assertOwnership: TaskOwnershipGuard,
          authorizeTransition: TaskOwnershipTransitionAuthorizer,
        ) => Promise<T>,
      ) => baseStore.withTaskOwnership!(taskId, environment, (lease, _transfer, assertOwnership, authorizeTransition) => operation(
        lease,
        async (targetEnvironment: Environment): Promise<TaskOwnershipLease> => {
          if (targetEnvironment === "work") throw new TaskOwnershipError("handoff ownership transfer failed");
          return _transfer(targetEnvironment);
        },
        assertOwnership,
        authorizeTransition,
      )),
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, store });
    const accepted = await handle(intentRequest("chat", noOverrides));

    const response = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });
    expect(response).toMatchObject({ taskId: accepted.taskId, status: "blocked" });
    await expect(baseStore.load(accepted.taskId)).resolves.toMatchObject({ stage: "handoff", handoffState: "pending", environment: "codex" });
    expect(runtimeHarness.savedStates.filter((state) => state.handoffState === "active")).toHaveLength(0);
  });

  it("persists a target-owned coordination state when durable handoff rollback also fails", async () => {
    const durableRoot = await mkdtemp(join(tmpdir(), "d-ai-runtime-handoff-recovery-"));
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const fileStore = new FileDurableContextStore(durableRoot);
    const observed = observeFileStoreOwnership(fileStore);
    let failActiveSave = true;
    const store: DurableContextStore = {
      ...observed.store,
      save: async (state: TaskState, authorization?: TaskOwnershipLease | TaskOwnershipTransition): Promise<DurableContextManifest> => {
        if (state.handoffState === "active" && failActiveSave) {
          failActiveSave = false;
          throw new InvalidTaskStateError("target active persistence failed");
        }
        return observed.store.save(state, authorization);
      },
      withTaskOwnership: <T>(
        taskId: string,
        environment: Environment,
        operation: (
          lease: TaskOwnershipLease,
          transfer: TaskOwnershipTransfer,
          assertOwnership: TaskOwnershipGuard,
          authorizeTransition: TaskOwnershipTransitionAuthorizer,
        ) => Promise<T>,
      ) => fileStore.withTaskOwnership!(taskId, environment, (lease, transfer, assertOwnership, authorizeTransition) => operation(
        lease,
        async (targetEnvironment: Environment): Promise<TaskOwnershipLease> => {
          const targetLease = await transfer(targetEnvironment);
          if (targetEnvironment === "work") {
            const leasePath = join(durableRoot, taskId, "ownership", targetLease.generation.toString(), "lease");
            const expiredAt = new Date(Date.now() - FILE_DURABLE_CONTEXT_LEASE_MS - 1_000);
            await utimes(leasePath, expiredAt, expiredAt);
          }
          return targetLease;
        },
        assertOwnership,
        authorizeTransition,
      )),
    };
    const handle = createDAIRuntime({ ...runtimeHarness.dependencies, store });

    try {
      vi.useFakeTimers({ now: new Date("2026-08-21T00:01:00.000Z") });
      const accepted = await handle(intentRequest("chat", noOverrides));
      expect(accepted.status, accepted.message).toBe("completed");
      const response = await handle({ command: { kind: "handoff", target: "work" }, sourceEnvironment: "codex", overrides: noOverrides });

      expect(response).toMatchObject({ taskId: accepted.taskId, status: "blocked" });
      await expect(fileStore.load(accepted.taskId)).resolves.toMatchObject({
        environment: "work",
        handoffState: "rejected",
        contextManifest: expect.arrayContaining([expect.stringMatching(/handoff-recovery-required/i)]),
      });
    } finally {
      vi.useRealTimers();
      await rm(durableRoot, { recursive: true, force: true });
    }
  });

  it("propagates a blocked gate and enters debug/recovery without claiming completion", async () => {
    const runtimeHarness = harness(completedExecution, blockedGates, "YES");
    const response = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(response.status).toBe("blocked");
    expect(response.stage).toBe("recover");
    expect(response.message).toMatch(/quality verification failed/i);
    expect(runtimeHarness.recoveredReasons).toEqual([expect.stringMatching(/quality verification failed/i)]);
  });

  it("blocks when the gate evaluator omits an applicable gate", async () => {
    const runtimeHarness = harness(completedExecution, omittedGates, "YES");
    const response = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(response.status).toBe("blocked");
    expect(response.message).toMatch(/missing.*scope.*gate/i);
    expect(runtimeHarness.recoveredReasons).toEqual([expect.stringMatching(/missing.*scope.*gate/i)]);
  });

  it("blocks when the applicable recovery gate fails after recovery capture", async () => {
    const runtimeHarness = harness(completedExecution, failedRecoveryGates, "YES");

    const result = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("recover");
    expect(result.message).toMatch(/recovery verification failed/i);
    expect(runtimeHarness.recoveredReasons).toEqual(["recovery verification failed"]);
  });

  it.each([
    ["malformed", "not-a-timestamp"],
    ["future", "2026-08-21T00:02:00.000Z"],
  ] as const)("blocks a %s injected recovery-point timestamp before persisting it", async (_label, createdAt) => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const captureRecoveryPoint = runtimeHarness.dependencies.captureRecoveryPoint;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint | CapturedRecoveryPoint> => ({
        ...await captureRecoveryPoint(state),
        createdAt,
      }),
    });

    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/timestamp|future|malformed/i);
    expect(runtimeHarness.savedStates.some((state) => state.recoveryPoint?.createdAt === createdAt)).toBe(false);
  });

  it("blocks a captured recovery snapshot with an unverified durable artifact before persisting it", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const captureRecoveryPoint = runtimeHarness.dependencies.captureRecoveryPoint;
    const extraPath = "unverified.json";
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint | CapturedRecoveryPoint> => {
        const captured = await captureRecoveryPoint(state);
        const recoveryPoint = "recoveryPoint" in captured ? captured.recoveryPoint : captured;
        const manifest = state.durableContext;
        if (manifest === null) throw new InvalidTaskStateError("Recovery capture requires durable context");
        return {
          trigger: "recovery",
          recoveryPoint: { ...recoveryPoint, snapshotManifestId: manifest.manifestId },
          snapshot: {
            head: "0123456789abcdef0123456789abcdef01234567",
            branch: "main",
            workspacePath: "C:/workspace",
            status: "clean",
            binaryPatch: "no patch required",
            stateManifest: {
              ...manifest,
              durablePaths: [...manifest.durablePaths, extraPath],
              hashes: { ...manifest.hashes, [extraPath]: "b".repeat(64) },
            },
            verificationResults: state.verificationEvidence,
            durableArtifacts: { ...manifest.hashes },
          },
        };
      },
    });

    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/recovery capture blocked|snapshot.*match/i);
    expect(runtimeHarness.savedStates.some((state) => state.recoverySnapshot?.stateManifest.durablePaths.includes(extraPath))).toBe(false);
  });

  it("blocks a captured recovery point bound to a different snapshot generation", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const captureRecoveryPoint = runtimeHarness.dependencies.captureRecoveryPoint;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint | CapturedRecoveryPoint> => {
        const captured = await captureRecoveryPoint(state);
        const recoveryPoint = "recoveryPoint" in captured ? captured.recoveryPoint : captured;
        const manifest = state.durableContext;
        if (manifest === null) throw new InvalidTaskStateError("Recovery capture requires durable context");
        return {
          trigger: "recovery",
          recoveryPoint: { ...recoveryPoint, snapshotManifestId: "00000000-0000-4000-8000-000000000009" },
          snapshot: {
            head: "0123456789abcdef0123456789abcdef01234567",
            branch: "main",
            workspacePath: "C:/workspace",
            status: "clean",
            binaryPatch: "no patch required",
            stateManifest: manifest,
            verificationResults: state.verificationEvidence,
            durableArtifacts: manifest.hashes,
          },
        };
      },
    });

    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/snapshot.*manifest|generation/i);
    expect(runtimeHarness.savedStates.some((state) => state.recoveryPoint?.snapshotManifestId === "00000000-0000-4000-8000-000000000009")).toBe(false);
  });

  it("propagates execution failure through debug/recovery", async () => {
    const runtimeHarness = harness(failedExecution, evaluateHardGates, "YES");
    const response = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("work", noOverrides));

    expect(response.status).toBe("blocked");
    expect(response.stage).toBe("recover");
    expect(response.evidence).toEqual([expect.objectContaining({ passed: false, exitCode: 1 })]);
    expect(runtimeHarness.recoveredReasons).toEqual(["execution did not complete"]);
  });

  it("persists debug session across a fresh runtime after execution failure", async () => {
    const durableRoot = await mkdtemp(join(tmpdir(), "d-ai-debug-session-runtime-"));
    let executionAttempts = 0;
    const runtimeHarness = harness((request) => {
      executionAttempts += 1;
      const result = executionAttempts === 1 ? failedExecution(request) : completedExecution(request);
      const recordedAt = new Date().toISOString();
      return { ...result, evidence: result.evidence.map((evidence) => ({ ...evidence, recordedAt })) };
    }, evaluateHardGates, "YES");
    const firstStore = new FileDurableContextStore(durableRoot);
    const observedStore = observeFileStoreOwnership(firstStore);
    const dependencies = { ...runtimeHarness.dependencies, store: observedStore.store, now: (): Date => new Date() };

    try {
      const firstResponse = await createDAIRuntime(dependencies)(intentRequest("work", noOverrides));
      expect(firstResponse.status).toBe("blocked");

      const persisted = await firstStore.load(firstResponse.taskId);
      expect(persisted).toMatchObject({
        environment: "codex",
        debugSession: {
          phase: "reverify",
          originalFailure: "execution did not complete",
          hypothesis: expect.stringMatching(/recovery hypothesis/i),
          preservedRecoveryPointId: expect.any(String),
        },
      });
      expect(observedStore.transitions()).toEqual([]);
      expect(observedStore.transfers()).toEqual(["codex"]);

      const freshStore = new FileDurableContextStore(durableRoot);
      const freshRuntime = createDAIRuntime({ ...dependencies, store: freshStore });
      const reloaded = await freshStore.load(firstResponse.taskId);
      expect(reloaded?.debugSession).toEqual(persisted?.debugSession);

      const continued = await freshRuntime({
        command: { kind: "continue", taskIdOrProject: firstResponse.taskId },
        sourceEnvironment: persisted?.environment ?? "codex",
        overrides: noOverrides,
      });
      expect(continued.status, continued.message).toBe("completed");

      await expect(freshStore.load(firstResponse.taskId)).resolves.toMatchObject({
        debugSession: persisted?.debugSession,
      });
    } finally {
      await rm(durableRoot, { recursive: true, force: true });
    }
  });

  it("blocks rollback when no active task exists", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let rollbackCalls = 0;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      rollbackTask: async (): Promise<RollbackResult> => {
        rollbackCalls += 1;
        return successfulRollbackResult();
      },
    });

    const result = await handle({ command: { kind: "rollback" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(result).toMatchObject({ taskId: "unassigned", status: "blocked", stage: "bootstrap" });
    expect(result.message).toMatch(/no active task/i);
    expect(rollbackCalls).toBe(0);
  });

  it("blocks rollback from an environment that does not own the active task", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let rollbackCalls = 0;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      rollbackTask: async (): Promise<RollbackResult> => {
        rollbackCalls += 1;
        return successfulRollbackResult();
      },
    });
    await handle(intentRequest("chat", noOverrides));

    const result = await handle({ command: { kind: "rollback" }, sourceEnvironment: "work", overrides: noOverrides });

    expect(result).toMatchObject({ status: "blocked", taskId: "unassigned" });
    expect(result.message).toMatch(/no active task/i);
    expect(rollbackCalls).toBe(0);
  });

  it("blocks rollback when the active task has no recovery point", async () => {
    const runtimeHarness = harness(failedExecution, evaluateHardGates, "YES");
    const rollbackCalls: TaskState[] = [];
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      rollbackTask: async (state): Promise<RollbackResult> => {
        rollbackCalls.push(state);
        return successfulRollbackResult();
      },
    });
    const failed = await handle(intentRequest("chat", noOverrides));

    const result = await handle({ command: { kind: "rollback" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(failed.status).toBe("blocked");
    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/recovery point/i);
    expect(rollbackCalls).toHaveLength(0);
  });

  it("returns a redacted blocked response when the rollback adapter fails", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      rollbackTask: async (): Promise<RollbackResult> => {
        throw new InvalidTaskStateError("rollback adapter failed token=rollback-secret");
      },
    });
    const accepted = await handle(intentRequest("codex", noOverrides));
    const acceptedState = await runtimeHarness.store.load(accepted.taskId);
    if (acceptedState?.durableContext === null || acceptedState?.durableContext === undefined || acceptedState.recoveryPoint === null) throw new InvalidTaskStateError("Rollback fixture did not persist recovery context");
    await runtimeHarness.store.save({
      ...acceptedState,
      recoveryPoint: { ...acceptedState.recoveryPoint, snapshotManifestId: acceptedState.durableContext.manifestId },
      recoverySnapshot: {
        head: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
        workspacePath: "C:/workspace",
        status: "clean",
        binaryPatch: "no patch required",
        stateManifest: acceptedState.durableContext,
        verificationResults: acceptedState.verificationEvidence,
        durableArtifacts: acceptedState.durableContext.hashes,
      },
    });
    const result = await handle({ command: { kind: "rollback" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(accepted.status).toBe("completed");
    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("verify");
    expect(result.message).toMatch(/rollback adapter failed/i);
    expect(result.message).toContain("[REDACTED]");
    expect(result.message).not.toContain("rollback-secret");
  });

  it("persists a blocked recovery audit when rollback verification fails after actions", async () => {
    const durableRoot = await mkdtemp(join(tmpdir(), "d-ai-runtime-partial-rollback-"));
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const durableStore = new FileDurableContextStore(durableRoot);
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store: durableStore,
      rollbackTask: async (): Promise<RollbackResult> => {
        throw new RollbackPartialFailureError({
          preservedUserWork: { archiveId: "archive-partial", patchDigest: "a".repeat(64) },
          actions: [{ command: "git", arguments: ["apply"], stdout: "applied", stderr: "", exitCode: 0 }],
          verification: { passed: false, observedOutput: "", reason: "second revert failed" },
        }, "second revert failed");
      },
    });
    try {
      const accepted = await handle(intentRequest("codex", noOverrides));
      const acceptedState = await durableStore.load(accepted.taskId);
      if (acceptedState?.durableContext === null || acceptedState?.durableContext === undefined || acceptedState.recoveryPoint === null) throw new InvalidTaskStateError("Rollback fixture did not persist recovery context");
      const acceptedRecoveryPoint = acceptedState.recoveryPoint;
      const snapshotManifest = acceptedState.durableContext;
      await durableStore.withTaskOwnership(accepted.taskId, acceptedState.environment, async (lease) => {
        await durableStore.save({
          ...acceptedState,
          recoveryPoint: {
            ...acceptedRecoveryPoint,
            durablePaths: snapshotManifest.durablePaths,
            hashes: snapshotManifest.hashes,
            snapshotManifestId: snapshotManifest.manifestId,
          },
          recoverySnapshot: {
            head: "0123456789abcdef0123456789abcdef01234567",
            branch: "main",
            workspacePath: "C:/workspace",
            status: "clean",
            binaryPatch: "no patch required",
            stateManifest: snapshotManifest,
            verificationResults: acceptedState.verificationEvidence,
            durableArtifacts: snapshotManifest.hashes,
          },
        }, lease);
      });

      const result = await handle({ command: { kind: "rollback" }, sourceEnvironment: "codex", overrides: noOverrides });
      const persisted = await new FileDurableContextStore(durableRoot).load(accepted.taskId);

      expect(result).toMatchObject({ status: "blocked", stage: "recover", message: expect.stringMatching(/partially completed|second revert failed/i) });
      expect(persisted).toMatchObject({ stage: "recover", role: "recovery-operator", rollbackAudit: { verification: { passed: false }, actions: [{ command: "git", arguments: ["apply"] }] } });
    } finally {
      await rm(durableRoot, { recursive: true, force: true });
    }
  });

  it("persists a verified rollback as recover while preserving debugSession and ownership lease", async () => {
    let executionAttempts = 0;
    const runtimeHarness = harness((request) => {
      executionAttempts += 1;
      return executionAttempts === 1 ? failedExecution(request) : completedExecution(request);
    }, evaluateHardGates, "YES");
    const rollbackCalls: Array<{ readonly state: TaskState; readonly lease: TaskOwnershipLease }> = [];
    const rerunStates: TaskState[] = [];
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      rollbackTask: async (state, lease): Promise<RollbackResult> => {
        rollbackCalls.push({ state, lease });
        return successfulRollbackResult();
      },
      rerunOriginalCheck: async (state): Promise<readonly VerificationEvidence[]> => {
        rerunStates.push(state);
        return completedExecution({ state, skills: [] }).evidence;
      },
    });
    const failed = await handle(intentRequest("codex", noOverrides));
    const recovered = await handle({ command: { kind: "continue", taskIdOrProject: failed.taskId }, sourceEnvironment: "codex", overrides: noOverrides });
    const beforeRollback = await runtimeHarness.store.load(failed.taskId);
    if (beforeRollback?.durableContext === null || beforeRollback?.durableContext === undefined || beforeRollback.recoveryPoint === null) throw new InvalidTaskStateError("Rollback fixture did not persist recovery context");
    await runtimeHarness.store.save({
      ...beforeRollback,
      recoveryPoint: { ...beforeRollback.recoveryPoint, snapshotManifestId: beforeRollback.durableContext.manifestId },
      recoverySnapshot: {
        head: "0123456789abcdef0123456789abcdef01234567",
        branch: "main",
        workspacePath: "C:/workspace",
        status: "clean",
        binaryPatch: "no patch required",
        stateManifest: beforeRollback.durableContext,
        verificationResults: beforeRollback.verificationEvidence,
        durableArtifacts: beforeRollback.durableContext.hashes,
      },
    });
    const result = await handle({ command: { kind: "rollback" }, sourceEnvironment: "codex", overrides: noOverrides });
    const afterRollback = await runtimeHarness.store.load(failed.taskId);

    expect(recovered.status).toBe("completed");
    expect(beforeRollback?.debugSession).not.toBeNull();
    expect(result).toMatchObject({ taskId: failed.taskId, stage: "recover", status: "accepted" });
    expect(result.message).toMatch(/rollback restored.*re-ran.*original failing check/i);
    expect(rerunStates).toHaveLength(1);
    expect(rollbackCalls).toHaveLength(1);
    expect(rollbackCalls[0]?.state.taskId).toBe(failed.taskId);
    expect(rollbackCalls[0]?.lease).toMatchObject({ taskId: failed.taskId, environment: "codex" });
    expect(afterRollback).toMatchObject({ stage: "recover", role: "recovery-operator", debugSession: beforeRollback?.debugSession, rollbackAudit: { archiveId: "archive-1", patchDigest: "a".repeat(64), verification: { passed: true } } });
  });

  it("executes @D-AI rollback through the real Git adapter and persists its audit", { timeout: 15_000 }, async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "d-ai-runtime-git-rollback-"));
    const git = async (argumentsList: readonly string[]): Promise<string> => (await runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath })).stdout.trim();
    try {
      await git(["init", "--initial-branch=main"]);
      await git(["config", "user.email", "d-ai-runtime@example.test"]);
      await git(["config", "user.name", "D-AI Runtime Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "known good\n", "utf8");
      await git(["add", "artifact.txt"]);
      await git(["commit", "-m", "known good"]);
      const recoveryHead = await git(["rev-parse", "HEAD"]);
      const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
      const handle = createDAIRuntime({
        ...runtimeHarness.dependencies,
        workspacePath: repositoryPath,
        repositoryPath,
        rollbackTask: createGitRollbackTask(repositoryPath),
        rerunOriginalCheck: async (state): Promise<readonly VerificationEvidence[]> => completedExecution({ state, skills: [] }).evidence,
        captureRecoveryPoint: async (state): Promise<CapturedRecoveryPoint> => {
          if (state.durableContext === null) throw new InvalidTaskStateError("Recovery capture requires durable context");
          const snapshot: RecoverySnapshot = {
            head: recoveryHead,
            branch: "main",
            workspacePath: repositoryPath,
            status: "",
            binaryPatch: "",
            stateManifest: state.durableContext,
            verificationResults: state.verificationEvidence,
            durableArtifacts: state.durableContext.hashes,
          };
          return {
            trigger: "recovery",
            recoveryPoint: {
              recoveryPointId: `recovery-${state.taskId}`,
              taskId: state.taskId,
              stage: state.stage,
              environment: state.environment,
              role: state.role,
              durablePaths: state.durableContext.durablePaths,
              hashes: state.durableContext.hashes,
              restorationInstructions: "Restore the known-good tree and preserve user work.",
              createdAt: "2026-08-21T00:01:00.000Z",
              snapshotManifestId: state.durableContext.manifestId,
            },
            snapshot,
          };
        },
      });

      const accepted = await handle(intentRequest("codex", noOverrides));
      expect(accepted.status).toBe("completed");
      await writeFile(join(repositoryPath, "artifact.txt"), "regression\n", "utf8");
      await git(["add", "artifact.txt"]);
      await git(["commit", "-m", "regression"]);
      await writeFile(join(repositoryPath, "user-work.txt"), "preserve me\n", "utf8");

      const result = await handle({ command: { kind: "rollback" }, sourceEnvironment: "codex", overrides: noOverrides });
      expect(result).toMatchObject({ status: "accepted", stage: "recover" });
      expect(await git(["show", "HEAD:artifact.txt"])).toBe("known good");
      expect(await git(["status", "--porcelain=v1"])).toBe("");
      expect(await git(["stash", "list"])).toMatch(/d-ai-rollback-/);
      const persisted = await runtimeHarness.store.load(accepted.taskId);
      expect(persisted?.rollbackAudit?.verification.passed).toBe(true);
      expect(persisted?.rollbackAudit?.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ command: "git", arguments: ["revert", "--no-edit", expect.any(String)] }),
        expect.objectContaining({ command: "git", arguments: ["apply", "--binary", "--allow-empty", expect.any(String)] }),
      ]));
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "invalid task state",
      (): Error => new InvalidTaskStateError("recovery connector unavailable token=recovery-state-secret"),
      "recovery-state-secret",
      /recovery connector unavailable/i,
    ],
    [
      "close blocked",
      (): Error => new CloseBlockedError("recovery close blocked token=recovery-close-secret"),
      "recovery-close-secret",
      /recovery close blocked/i,
    ],
    [
      "command execution",
      (): Error => new CommandExecutionError({
        command: "recover token=recovery-command-secret",
        arguments: [],
        stdout: "",
        stderr: "authorization: Bearer recovery-output-secret",
        exitCode: 9,
      }),
      "recovery-output-secret",
      /command execution failed/i,
    ],
  ] as const)("returns a redacted blocked response and retains debug state when recovery throws %s", async (_label, errorFactory, secret, message) => {
    const runtimeHarness = harness(failedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      recover: async (): Promise<TaskState> => { throw errorFactory(); },
    });

    const result = await handle(intentRequest("work", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("debug");
    expect(result.message).toMatch(message);
    expect(result.message).toContain("[REDACTED]");
    expect(result.message).not.toContain(secret);
    expect(runtimeHarness.savedStates.at(-1)?.stage).toBe("debug");
    await expect(runtimeHarness.store.load(result.taskId)).resolves.toMatchObject({ stage: "debug", role: "debugger" });
  });

  it.each([
    ["YES", "completed"],
    ["NO", "blocked"],
    ["BLOCKED", "blocked"],
  ] as const)("propagates close verdict %s as %s without invoking execution or deletion", async (verdict, expectedStatus) => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, verdict);
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("codex", noOverrides));
    await handle({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides });
    const executionsBeforeClose = runtimeHarness.executed.length;
    const sentinelPath = join(skillRoot, "typescript-execution", "SKILL.md");
    const sentinelBefore = await readFile(sentinelPath, "utf8");

    const response = await handle({ command: { kind: "close" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(response.status).toBe(expectedStatus);
    expect(runtimeHarness.executed).toHaveLength(executionsBeforeClose);
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe(sentinelBefore);
    expect(response.message).toMatch(verdict === "YES" ? /yes/i : new RegExp(verdict, "i"));
    expect(runtimeHarness.closedStates.at(-1)?.stage).toBe("verify");
  });

  it("blocks explicit continue when the durable task belongs to another workspace", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const initial = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await initial(intentRequest("codex", noOverrides));
    const otherWorkspace = join(process.cwd(), "tests", "fixtures", "unrelated-workspace");
    const fresh = createDAIRuntime({ ...runtimeHarness.dependencies, workspacePath: otherWorkspace });

    const result = await fresh({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(result).toMatchObject({ taskId: accepted.taskId, status: "blocked" });
    expect(result.message).toMatch(/different workspace/i);
  });

  it("applies continue routing overrides to the durable routing decision", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("codex", noOverrides));

    const result = await handle({
      command: { kind: "continue", taskIdOrProject: accepted.taskId },
      sourceEnvironment: "codex",
      overrides: { model: "codex-model", role: "implementer", environment: null, stage: "execute" },
    });
    const persisted = await runtimeHarness.store.load(accepted.taskId);

    expect(result.status).toBe("accepted");
    expect(persisted?.routingDecision).toMatchObject({
      stage: "verify",
      requestedStage: "execute",
      role: "implementer",
      selectedModel: "codex-model",
      overrideSource: "user",
    });
  });

  it("fails closed when continue routing overrides have no compatible policy", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("codex", noOverrides));

    const result = await handle({
      command: { kind: "continue", taskIdOrProject: accepted.taskId },
      sourceEnvironment: "codex",
      overrides: { model: "missing-model", role: "reviewer", environment: null, stage: "execute" },
    });

    expect(result).toMatchObject({ taskId: accepted.taskId, status: "blocked" });
    expect(result.message).toMatch(/routing override blocked|no model policy/i);
  });

  it("preserves valid continue routing overrides when resuming recovery", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      modelPolicies: [
        ...policies,
        { stage: "execute", role: "reviewer", model: "recovery-review-model", requiredCapabilities: ["local-execution"], compatibleEnvironments: ["codex"] },
      ],
    });
    const accepted = await handle(intentRequest("codex", noOverrides));
    const state = await runtimeHarness.store.load(accepted.taskId);
    if (state === null) throw new InvalidTaskStateError("Expected durable task state");
    await runtimeHarness.store.save({ ...state, stage: "recover", role: "recovery-operator", durableContext: null });

    const result = await handle({
      command: { kind: "continue", taskIdOrProject: accepted.taskId },
      sourceEnvironment: "codex",
      overrides: { model: "recovery-review-model", role: "reviewer", environment: null, stage: "execute" },
    });
    const executed = runtimeHarness.executed.at(-1);

    expect(["accepted", "completed"], result.message).toContain(result.status);
    expect(executed?.state).toMatchObject({ stage: "execute", role: "reviewer" });
    expect(executed?.state.routingDecision).toMatchObject({ selectedModel: "recovery-review-model", role: "reviewer" });
  });

  it("does not reuse a historical requested stage when resuming recovery", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await handle(intentRequest("codex", noOverrides));
    const state = await runtimeHarness.store.load(accepted.taskId);
    if (state === null || state.routingDecision === null) throw new InvalidTaskStateError("Expected durable routed task state");
    await runtimeHarness.store.save({
      ...state,
      stage: "recover",
      role: "recovery-operator",
      routingDecision: { ...state.routingDecision, stage: "recover", role: "recovery-operator", requestedStage: "plan" },
      durableContext: null,
    });

    const result = await handle({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides });
    const executed = runtimeHarness.executed.at(-1);

    expect(["accepted", "completed"], result.message).toContain(result.status);
    expect(executed?.state).toMatchObject({ stage: "execute", role: "implementer" });
  });

  it("selects an explicit durable task for close in a fresh runtime", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const seedingRuntime = createDAIRuntime(runtimeHarness.dependencies);
    const accepted = await seedingRuntime(intentRequest("codex", noOverrides));
    const freshRuntime = createDAIRuntime(runtimeHarness.dependencies);

    const result = await freshRuntime({
      command: { kind: "close" },
      sourceEnvironment: "codex",
      overrides: noOverrides,
      activeTaskId: accepted.taskId,
    });

    expect(result).toMatchObject({
      taskId: accepted.taskId,
      stage: "close",
      environment: "codex",
      status: "completed",
      message: "Safe-to-delete: YES",
    });
  });

  it("keeps a NO close retryable in verify before the real close evaluator runs", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const gitHub: GitHubAdapter = {
      pushExpectedCommit: async (): Promise<GitPushEvidence> => {
        throw new Error("GitHub must not run after failed close preflight");
      },
      verifyRemoteState: async (): Promise<RemoteState> => {
        throw new Error("GitHub must not run after failed close preflight");
      },
    };
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      closeTask: async (state, lease, assertOwnership): Promise<CloseVerdict> => closeTask(state, { store: runtimeHarness.store, gitHub }, lease, assertOwnership),
    });
    await handle(intentRequest("codex", noOverrides));

    const result = await handle({ command: { kind: "close" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(result.stage).toBe("verify");
    expect(result.status).toBe("blocked");
    expect(runtimeHarness.savedStates.at(-1)?.stage).toBe("verify");
  });

  it("retries a NO close with the same runtime and durable store", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let closeAttempt = 0;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      closeTask: async (state): Promise<CloseVerdict> => {
        closeAttempt += 1;
        return closeVerdict(state, closeAttempt === 1 ? "NO" : "YES");
      },
    });
    const accepted = await handle(intentRequest("codex", noOverrides));
    await handle({ command: { kind: "continue", taskIdOrProject: accepted.taskId }, sourceEnvironment: "codex", overrides: noOverrides });

    const first = await handle({ command: { kind: "close" }, sourceEnvironment: "codex", overrides: noOverrides });
    expect(first).toMatchObject({ taskId: accepted.taskId, stage: "verify", status: "blocked" });
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "verify" });

    const second = await handle({ command: { kind: "close" }, sourceEnvironment: "codex", overrides: noOverrides });
    expect(second).toMatchObject({ taskId: accepted.taskId, stage: "close", status: "completed" });
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "close" });
  });

  it("returns blocked when the close connector throws and preserves its reason", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      closeTask: async (): Promise<CloseVerdict> => {
        throw new CloseBlockedError("close connector unavailable token=close-secret");
      },
    });
    await handle(intentRequest("codex", noOverrides));

    const result = await handle({ command: { kind: "close" }, sourceEnvironment: "codex", overrides: noOverrides });

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/close connector unavailable/i);
    expect(result.message).toContain("[REDACTED]");
    expect(result.message).not.toContain("close-secret");
  });

  it("converts a typed execution connector error to a redacted blocked response", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const executor = async (): Promise<EnvironmentExecutionResult> => {
      throw new CommandExecutionError({
        command: "runner token=connector-command-secret",
        arguments: [],
        stdout: "",
        stderr: "authorization: Bearer connector-output-secret",
        exitCode: 7,
      });
    };
    const adapters: Readonly<Record<Environment, DAIEnvironmentAdapter>> = {
      chat: new ChatEnvironmentAdapter(runtimeHarness.handoffService, executor),
      work: new WorkEnvironmentAdapter(runtimeHarness.handoffService, executor),
      codex: new CodexEnvironmentAdapter(runtimeHarness.handoffService, executor),
    };

    const result = await createDAIRuntime({ ...runtimeHarness.dependencies, adapters })(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.stage).toBe("recover");
    expect(result.message).toMatch(/command execution failed/i);
    expect(result.message).toContain("[REDACTED]");
    expect(JSON.stringify(runtimeHarness.savedStates)).not.toContain("connector-output-secret");
    expect(JSON.stringify(result)).not.toContain("connector-output-secret");
  });

  it("redacts external execution evidence and messages before persistence and response", async () => {
    const runtimeHarness = harness(secretExecution, evaluateHardGates, "YES");

    const result = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    const serializedPersistence = JSON.stringify(runtimeHarness.savedStates);
    const serializedResponse = JSON.stringify(result);
    for (const secret of [
      "evidence-command-secret",
      "evidence-output-secret",
      "evidence-interpretation-secret",
      "execution-message-secret",
    ]) {
      expect(serializedPersistence).not.toContain(secret);
      expect(serializedResponse).not.toContain(secret);
    }
    expect(serializedPersistence).toContain("[REDACTED]");
    expect(serializedResponse).toContain("[REDACTED]");
  });

  it.each([
    {
      label: "recovery point id",
      secret: "id-secret",
      inject: (captured: RecoveryPoint): RecoveryPoint => ({ ...captured, recoveryPointId: "recovery-token=id-secret" }),
    },
    {
      label: "task id",
      secret: "task-secret",
      inject: (captured: RecoveryPoint): RecoveryPoint => ({ ...captured, taskId: "task-token=task-secret" }),
    },
    {
      label: "durable path",
      secret: "path-secret",
      inject: (captured: RecoveryPoint): RecoveryPoint => ({ ...captured, durablePaths: ["token=path-secret"] }),
    },
    {
      label: "hash key",
      secret: "apiKey",
      inject: (captured: RecoveryPoint): RecoveryPoint => ({ ...captured, hashes: { ...captured.hashes, apiKey: "b".repeat(64) } }),
    },
    {
      label: "restoration instructions",
      secret: "instructions-secret",
      inject: (captured: RecoveryPoint): RecoveryPoint => ({ ...captured, restorationInstructions: "Restore token=instructions-secret" }),
    },
  ] as const)("rejects labelled secret-like text in the injected recovery-point $label before persistence", async ({ secret, inject }) => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const secretSavedStates: TaskState[] = [];
    const secretStore = memoryStore(secretSavedStates, "state.json");
    const captureRecoveryPoint = runtimeHarness.dependencies.captureRecoveryPoint;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store: secretStore,
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint | CapturedRecoveryPoint> => inject(await captureRecoveryPoint(state) as RecoveryPoint),
    });

    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/secret-like/i);
    expect(secretSavedStates.every((state) => state.recoveryPoint === null)).toBe(true);
    expect(JSON.stringify(secretSavedStates.map((state) => state.recoveryPoint))).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    {
      signature: "sk-proj",
      secret: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
      inject: (captured: RecoveryPoint, secret: string): RecoveryPoint => ({ ...captured, recoveryPointId: `recovery-${secret}` }),
    },
    {
      signature: "sk",
      secret: "sk-abcdefghijklmnopqrstuvwxyz0123456789",
      inject: (captured: RecoveryPoint, secret: string): RecoveryPoint => ({ ...captured, taskId: secret }),
    },
    {
      signature: "ghp",
      secret: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      inject: (captured: RecoveryPoint, secret: string): RecoveryPoint => ({ ...captured, durablePaths: [`artifacts/${secret}`] }),
    },
    {
      signature: "github_pat",
      secret: "github_pat_abcdefghijklmnopqrstuvwxyz_0123456789",
      inject: (captured: RecoveryPoint, secret: string): RecoveryPoint => ({ ...captured, hashes: { ...captured.hashes, [secret]: "b".repeat(64) } }),
    },
    {
      signature: "PEM private key",
      secret: "-----BEGIN PRIVATE KEY-----",
      inject: (captured: RecoveryPoint, secret: string): RecoveryPoint => ({ ...captured, restorationInstructions: `${secret}\nprivate-key-material` }),
    },
  ] as const)("rejects an unlabelled $signature credential signature before recovery-point persistence", async ({ secret, inject }) => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const captureRecoveryPoint = runtimeHarness.dependencies.captureRecoveryPoint;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint | CapturedRecoveryPoint> => inject(await captureRecoveryPoint(state) as RecoveryPoint, secret),
    });

    const savedBeforeCapture = runtimeHarness.savedStates.length;
    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/secret-like/i);
    expect(runtimeHarness.savedStates.slice(savedBeforeCapture).every((state) => state.recoveryPoint === null)).toBe(true);
    expect(JSON.stringify(runtimeHarness.savedStates.map((state) => state.recoveryPoint))).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    ["process status", (snapshot: RecoverySnapshot, secret: string): RecoverySnapshot => ({ ...snapshot, status: `process=token=${secret}` })],
    ["binary patch", (snapshot: RecoverySnapshot, secret: string): RecoverySnapshot => ({ ...snapshot, binaryPatch: `diff --git a/file b/file\npassword=${secret}` })],
  ] as const)("rejects secret-like values in the captured recovery snapshot $0 before persistence", async (_label, inject) => {
    const secret = "snapshot-secret-value";
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const secretSavedStates: TaskState[] = [];
    const secretStore = memoryStore(secretSavedStates, "state.json");
    const captureRecoveryPoint = runtimeHarness.dependencies.captureRecoveryPoint;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store: secretStore,
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint | CapturedRecoveryPoint> => {
        const captured = await captureRecoveryPoint(state) as RecoveryPoint;
        if (state.durableContext === null) throw new InvalidTaskStateError("Snapshot fixture requires durable context");
        const snapshot: RecoverySnapshot = {
          head: "0123456789abcdef0123456789abcdef01234567",
          branch: "main",
          workspacePath: "C:/workspace",
          status: "",
          binaryPatch: "",
          stateManifest: state.durableContext,
          verificationResults: state.verificationEvidence,
          durableArtifacts: state.durableContext.hashes,
        };
        return { trigger: "recovery", recoveryPoint: captured, snapshot: inject(snapshot, secret) };
      },
    });

    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/snapshot.*secret-like/i);
    expect(secretSavedStates.every((state) => state.recoveryPoint === null)).toBe(true);
  });

  it("rejects malformed external request overrides without alternate interpretation", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const malformed: ExternalDAIRequest = {
      command: { kind: "intent", text: "model=unsupported continue task-1" },
      sourceEnvironment: "chat",
      overrides: { model: null, role: "not-a-role", environment: null },
    };

    await expect(createDAIRuntime(runtimeHarness.dependencies)(malformed)).rejects.toThrow(InvalidTaskStateError);
    expect(runtimeHarness.executed).toEqual([]);
  });
});
