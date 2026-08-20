import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { bootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { InvalidTaskStateError } from "../../src/domain/errors.js";
import type { CloseVerdict, DurableContextManifest, Environment, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { parseDAICommand } from "../../src/entry/command-parser.js";
import { InMemoryHandoffPersistence, PersistentHandoffService } from "../../src/handoff/handoff-service.js";
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
} from "../../src/runtime/d-ai-runtime.js";
import { discoverSkillMetadata, selectCapabilities } from "../../src/skills/registry.js";
import { loadSelectedSkill } from "../../src/skills/skill-loader.js";
import type { DurableContextStore } from "../../src/state/durable-context-store.js";
import type { GateResult, HardGateInput } from "../../src/verification/gates.js";

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

interface RuntimeHarness {
  readonly dependencies: DAIRuntimeDependencies;
  readonly executed: EnvironmentExecutionRequest[];
  readonly loadedSkills: string[];
  readonly recoveredReasons: string[];
  readonly handoffService: PersistentHandoffService;
  readonly store: DurableContextStore;
}

function memoryStore(): DurableContextStore {
  const states = new Map<string, TaskState>();
  return {
    load: async (taskId: string): Promise<TaskState | null> => states.get(taskId) ?? null,
    save: async (state: TaskState): Promise<DurableContextManifest> => {
      const manifest: DurableContextManifest = {
        manifestId: `manifest-${state.taskId}-${state.stage}`,
        taskId: state.taskId,
        stage: state.stage,
        environment: state.environment,
        role: state.role,
        durablePaths: ["state.json"],
        hashes: { "state.json": "a".repeat(64) },
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

function evidenceFor(request: EnvironmentExecutionRequest, passed: boolean): VerificationEvidence {
  const decision = request.state.routingDecision;
  if (decision === null) throw new InvalidTaskStateError("Execution requires a routing decision");
  return {
    evidenceId: passed ? "execution:passed" : "execution:failed",
    stage: request.state.stage,
    environment: request.state.environment,
    role: request.state.role,
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

function passingGates(input: HardGateInput): readonly GateResult[] {
  return ["scope", "environment-capability", "task-state", "quality", "failure-handling", "durable-context", "critical-unsaved-context"].map((gate) => ({
    gate,
    passed: true,
    observedOutput: input.state.verificationEvidence[0]?.observedOutput ?? "passed",
    exitCode: 0,
    reason: "passed",
  }));
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
  executionStatus: EnvironmentExecutionResult["status"],
  evaluateGates: (input: HardGateInput) => readonly GateResult[],
  closeStatus: CloseVerdict["status"],
): RuntimeHarness {
  const store = memoryStore();
  const handoffService = new PersistentHandoffService(new InMemoryHandoffPersistence());
  const executed: EnvironmentExecutionRequest[] = [];
  const loadedSkills: string[] = [];
  const recoveredReasons: string[] = [];
  const executor = async (request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> => {
    executed.push(request);
    const passed = executionStatus === "completed";
    return {
      status: executionStatus,
      evidence: [evidenceFor(request, passed)],
      message: passed ? "execution completed" : "execution did not complete",
    };
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
    recover: async (state, reason): Promise<TaskState> => {
      recoveredReasons.push(reason);
      return { ...state, stage: "recover", role: "recovery-operator" };
    },
    closeTask: async (state): Promise<CloseVerdict> => closeVerdict(state, closeStatus),
    maximumEvidenceAgeMs: 300_000,
    now: (): Date => new Date("2026-08-21T00:01:00.000Z"),
  };
  return { dependencies, executed, loadedSkills, recoveredReasons, handoffService, store };
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
  it.each(["chat", "work", "codex"] as const)("normalizes equivalent intent from %s and executes in the routed environment", async (sourceEnvironment) => {
    const runtimeHarness = harness("completed", passingGates, "YES");
    const handle = createDAIRuntime(runtimeHarness.dependencies);

    const response = await handle(intentRequest(sourceEnvironment, noOverrides));

    expect(response.status).toBe("completed");
    expect(response.environment).toBe("codex");
    expect(runtimeHarness.executed).toHaveLength(1);
    expect(runtimeHarness.executed[0]?.state.goal).toBe("implement typescript");
  });

  it("honors routing overrides and loads only the minimum selected Skill", async () => {
    const runtimeHarness = harness("completed", passingGates, "YES");
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
    const runtimeHarness = harness("completed", passingGates, "YES");
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
  });

  it("propagates a blocked gate and enters debug/recovery without claiming completion", async () => {
    const runtimeHarness = harness("completed", blockedGates, "YES");
    const response = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(response.status).toBe("blocked");
    expect(response.stage).toBe("recover");
    expect(response.message).toMatch(/quality verification failed/i);
    expect(runtimeHarness.recoveredReasons).toEqual([expect.stringMatching(/quality verification failed/i)]);
  });

  it("blocks when the gate evaluator omits an applicable gate", async () => {
    const runtimeHarness = harness("completed", omittedGates, "YES");
    const response = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("chat", noOverrides));

    expect(response.status).toBe("blocked");
    expect(response.message).toMatch(/missing.*scope.*gate/i);
    expect(runtimeHarness.recoveredReasons).toEqual([expect.stringMatching(/missing.*scope.*gate/i)]);
  });

  it("propagates execution failure through debug/recovery", async () => {
    const runtimeHarness = harness("failed", passingGates, "YES");
    const response = await createDAIRuntime(runtimeHarness.dependencies)(intentRequest("work", noOverrides));

    expect(response.status).toBe("blocked");
    expect(response.stage).toBe("recover");
    expect(response.evidence).toEqual([expect.objectContaining({ passed: false, exitCode: 1 })]);
    expect(runtimeHarness.recoveredReasons).toEqual(["execution did not complete"]);
  });

  it.each([
    ["YES", "completed"],
    ["NO", "blocked"],
    ["BLOCKED", "blocked"],
  ] as const)("propagates close verdict %s as %s without invoking execution or deletion", async (verdict, expectedStatus) => {
    const runtimeHarness = harness("completed", passingGates, verdict);
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
  });

  it("rejects malformed external request overrides without alternate interpretation", async () => {
    const runtimeHarness = harness("completed", passingGates, "YES");
    const malformed: object = {
      command: { kind: "intent", text: "model=unsupported continue task-1" },
      sourceEnvironment: "chat",
      overrides: { model: null, role: "not-a-role", environment: null },
    };

    await expect(createDAIRuntime(runtimeHarness.dependencies)(malformed)).rejects.toThrow(InvalidTaskStateError);
    expect(runtimeHarness.executed).toEqual([]);
  });
});
