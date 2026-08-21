import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CommandExecutionError } from "../../src/adapters/command-runner.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { bootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { closeTask } from "../../src/close/close-service.js";
import { CloseBlockedError, InvalidTaskStateError } from "../../src/domain/errors.js";
import type { CloseVerdict, DurableContextManifest, Environment, RecoveryPoint, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { parseDAICommand } from "../../src/entry/command-parser.js";
import { InMemoryHandoffPersistence, PersistentHandoffService, type HandoffService, type HandoffStatus } from "../../src/handoff/handoff-service.js";
import type { HandoffEnvelope } from "../../src/handoff/envelope.js";
import type { GitHubAdapter, GitPushEvidence, RemoteState } from "../../src/adapters/github.js";
import type { EnvironmentCapabilities } from "../../src/routing/environment-capabilities.js";
import { selectEnvironment } from "../../src/routing/environment-router.js";
import { resolveModelRoute, type ModelPolicy } from "../../src/routing/model-router.js";
import { createDebugSession } from "../../src/debugging/debug-session.js";
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
import type { DurableContextStore } from "../../src/state/durable-context-store.js";
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
    expect(runtimeHarness.savedStates.some((state) => state.routingDecision?.requestedStage === stage)).toBe(true);
  });

  it.each([
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
      captureRecoveryPoint: async (state): Promise<RecoveryPoint> => {
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
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
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
    };
    const captureAttempts: TaskState[] = [];
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store: failingStore,
      captureRecoveryPoint: async (state): Promise<RecoveryPoint> => {
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
    await expect(runtimeHarness.store.load(accepted.taskId)).resolves.toMatchObject({ stage: "verify", handoffState: "completed", recoveryPoint: { recoveryPointId: expect.any(String) } });
  });

  it("leaves the task retryable when the handoff service completion fails", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    let failCompletion = true;
    const handoffService: HandoffService = {
      ready: () => runtimeHarness.handoffService.ready(),
      create: (input) => runtimeHarness.handoffService.create(input),
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
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint> => ({
        ...await captureRecoveryPoint(state),
        createdAt,
      }),
    });

    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/timestamp|future|malformed/i);
    expect(runtimeHarness.savedStates.some((state) => state.recoveryPoint?.createdAt === createdAt)).toBe(false);
  });

  it("propagates execution failure through debug/recovery", async () => {
    const runtimeHarness = harness(failedExecution, evaluateHardGates, "YES");
    const response = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("work", noOverrides));

    expect(response.status).toBe("blocked");
    expect(response.stage).toBe("recover");
    expect(response.evidence).toEqual([expect.objectContaining({ passed: false, exitCode: 1 })]);
    expect(runtimeHarness.recoveredReasons).toEqual(["execution did not complete"]);
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
      closeTask: async (state): Promise<CloseVerdict> => closeTask(state, { store: runtimeHarness.store, gitHub }),
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
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint> => inject(await captureRecoveryPoint(state)),
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
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint> => inject(await captureRecoveryPoint(state), secret),
    });

    const savedBeforeCapture = runtimeHarness.savedStates.length;
    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/secret-like/i);
    expect(runtimeHarness.savedStates.slice(savedBeforeCapture).every((state) => state.recoveryPoint === null)).toBe(true);
    expect(JSON.stringify(runtimeHarness.savedStates.map((state) => state.recoveryPoint))).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
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
