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
import { InMemoryHandoffPersistence, PersistentHandoffService, type HandoffStatus } from "../../src/handoff/handoff-service.js";
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
        manifestId: `manifest-${state.taskId}-${state.stage}`,
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
    expect(runtimeHarness.closedStates.at(-1)?.stage).toBe("close");
  });

  it("transitions and persists verify to close before the real close evaluator runs", async () => {
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

    expect(result.stage).toBe("close");
    expect(result.status).toBe("blocked");
    expect(result.message).not.toMatch(/not explicitly invoked/i);
    expect(runtimeHarness.savedStates.at(-1)?.stage).toBe("close");
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

  it("rejects secret-like text in every injected recovery-point text surface before persistence", async () => {
    const runtimeHarness = harness(completedExecution, evaluateHardGates, "YES");
    const secretSavedStates: TaskState[] = [];
    const secretStore = memoryStore(secretSavedStates, "token=path-secret");
    const captureRecoveryPoint = runtimeHarness.dependencies.captureRecoveryPoint;
    const handle = createDAIRuntime({
      ...runtimeHarness.dependencies,
      store: secretStore,
      captureRecoveryPoint: async (state: TaskState): Promise<RecoveryPoint> => {
        const captured = await captureRecoveryPoint(state);
        return {
          ...captured,
          recoveryPointId: "recovery-token=id-secret",
          hashes: { ...captured.hashes, apiKey: "b".repeat(64) },
          restorationInstructions: "Restore token=instructions-secret",
        };
      },
    });

    const result = await handle(intentRequest("chat", noOverrides));

    expect(result.status).toBe("blocked");
    expect(result.message).toMatch(/secret-like/i);
    expect(secretSavedStates.every((state) => state.recoveryPoint === null)).toBe(true);
    for (const secret of ["path-secret", "id-secret", "instructions-secret", "apiKey"]) {
      expect(JSON.stringify(secretSavedStates.map((state) => state.recoveryPoint))).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }
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
