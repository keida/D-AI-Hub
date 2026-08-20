import { runCommand, CommandExecutionError, type CommandResult } from "../../src/adapters/command-runner.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { GitHubCliAdapter, type GitHubAdapter } from "../../src/adapters/github.js";
import { readRemoteRef } from "../../src/adapters/git.js";
import { closeTask } from "../../src/close/close-service.js";
import { createRecoveryPoint } from "../../src/recovery/recovery-point-service.js";
import type { CloseVerdict, Environment, RecoveryPoint, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { FileHandoffPersistence, PersistentHandoffService, type HandoffStatus } from "../../src/handoff/handoff-service.js";
import { createDAIRuntime, handleDAIRequest, type DAIRuntimeDependencies, type EnvironmentExecutionRequest, type EnvironmentExecutionResult } from "../../src/runtime/d-ai-runtime.js";
import { discoverSkillMetadata, selectCapabilities } from "../../src/skills/registry.js";
import { loadSelectedSkill, type LoadedSkill } from "../../src/skills/skill-loader.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { evaluateHardGates, type GateName } from "../../src/verification/gates.js";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createKnownGoodRepository, type KnownGoodRepositoryFixture } from "./fixtures/known-good-repo.js";

const noOverrides = { model: null, role: null, environment: null } as const;

interface LifecycleTrace {
  readonly responses: { taskId: string; stage: string; environment: Environment; status: string; message: string }[];
  readonly handoffSnapshots: HandoffStatus[];
  readonly loadedSkills: LoadedSkill[];
  readonly requestedResources: { name: string; resources: readonly string[] }[];
  failedResult: CommandResult;
  passingResult: CommandResult;
  regressionResult: CommandResult;
}

interface RuntimeFixture {
  readonly runtime: ReturnType<typeof createDAIRuntime>;
  readonly store: FileDurableContextStore;
  readonly handoffs: PersistentHandoffService;
  readonly trace: LifecycleTrace;
}

function evidence(state: TaskState, gate: GateName, command: string, observedOutput: string, recordedAt: string): VerificationEvidence {
  return { evidenceId: `gate:${gate}`, stage: "verify", environment: state.environment, role: "evidence-collector", selectedModel: state.routingDecision?.selectedModel ?? "codex-default", command, observedOutput, exitCode: 0, interpretation: `${gate} evidence was derived from ${command}`, passed: true, recoveryPointId: null, recordedAt };
}

async function expectedFailure(command: Parameters<typeof runCommand>[0]): Promise<CommandResult> {
  try { await runCommand(command); } catch (error: unknown) { if (error instanceof CommandExecutionError) return error.result; throw error; }
  throw new Error("The failing Task 10 command unexpectedly passed");
}

function localGitHubAdapter(fixture: KnownGoodRepositoryFixture): GitHubAdapter {
  return GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, {
    pushRef: async (repositoryPath, _endpoint, ref, head) => {
      const result = await runCommand({ command: "git", arguments: ["push", fixture.bareRemotePath, `${head}:${ref}`], cwd: repositoryPath });
      return { pushed: result.exitCode === 0, observedOutput: result.stdout || result.stderr, exitCode: result.exitCode ?? 1, failureCategory: null };
    },
    readRef: async (_repositoryPath, _endpoint, ref) => readRemoteRef(fixture.bareRemotePath, ref, null),
  });
}

async function makeRuntimeFixture(fixture: KnownGoodRepositoryFixture): Promise<RuntimeFixture> {
  const store = new FileDurableContextStore(fixture.durableContextRoot);
  const handoffs = new PersistentHandoffService(new FileHandoffPersistence(fixture.handoffPersistencePath));
  const trace: LifecycleTrace = { responses: [], handoffSnapshots: [], loadedSkills: [], requestedResources: [], failedResult: null as never, passingResult: null as never, regressionResult: null as never };
  let failedResult: CommandResult | null = null;
  let passingResult: CommandResult | null = null;
  let regressionResult: CommandResult | null = null;
  const { bootstrapTask } = await import("../../src/bootstrap/bootstrap-task.js");
  const bootstrap = async (input: Parameters<typeof bootstrapTask>[0], targetStore: Parameters<typeof bootstrapTask>[1]): Promise<TaskState> => {
    const state = await bootstrapTask(input, targetStore);
    return { ...state, constraints: ["Use only the disposable Task 10 repository"], contextManifest: [...state.contextManifest, "remote:origin", `ref:${fixture.ref}`, "local-state:clean-required", `artifact:commit:${fixture.commitSha}`], durableContext: null };
  };
  const executor = async (request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> => {
    const durableBeforeExecution = await store.load(request.state.taskId);
    if (durableBeforeExecution === null) throw new Error("Runtime did not persist the task before execution");
    if (failedResult === null) {
      failedResult = await expectedFailure(fixture.failingCommand);
      const now = new Date().toISOString();
      return {
        status: "failed",
        message: "Configured failing command reproduced the public intent failure",
        evidence: [
          evidence(request.state, "scope", "fixture scope", "scope recorded", now),
          { ...evidence(request.state, "failure-handling", fixture.failingCommand.command, failedResult.stderr, now), passed: false, exitCode: failedResult.exitCode },
        ],
      };
    }
    passingResult = await runCommand(fixture.failingCommand);
    regressionResult = await runCommand(fixture.regressionCommand);
    const now = new Date().toISOString();
    const statusOutput = (await runCommand({ command: "git", arguments: ["status", "--porcelain=v1"], cwd: fixture.repositoryPath })).stdout;
    const headOutput = (await runCommand({ command: "git", arguments: ["rev-parse", "HEAD"], cwd: fixture.repositoryPath })).stdout.trim();
    const durable = await store.load(request.state.taskId);
    if (durable === null) throw new Error("Runtime did not persist the task before execution");
    return { status: "completed", message: "Codex reproduced the failure, recovered, and reverified the fixture", evidence: [
      evidence(request.state, "scope", "git status --porcelain=v1", statusOutput || "clean worktree", now),
      evidence(request.state, "environment-capability", "git rev-parse --show-toplevel", fixture.repositoryPath, now),
      evidence(request.state, "task-state", "git rev-parse HEAD", headOutput, now),
      evidence(request.state, "quality", `${fixture.failingCommand.command} ${fixture.failingCommand.arguments.join(" ")}`, passingResult.stdout, now),
      evidence(request.state, "failure-handling", `${fixture.failingCommand.command} (recovered)`, `${failedResult.stderr}${passingResult.stdout}`, now),
      evidence(request.state, "durable-context", `FileDurableContextStore.load(${request.state.taskId})`, durable.durableContext?.durablePaths.join("\n") ?? "missing", now),
      evidence(request.state, "critical-unsaved-context", "FileDurableContextStore.load criticalUnsavedContext", durable.criticalUnsavedContext.join("\n") || "empty", now),
      evidence(request.state, "recovery", "git rev-parse HEAD + recovery-point capture", headOutput, now),
    ] };
  };
  const adapters = { chat: new ChatEnvironmentAdapter(handoffs, executor), work: new WorkEnvironmentAdapter(handoffs, executor), codex: new CodexEnvironmentAdapter(handoffs, executor) };
  const captureRecoveryPoint = async (state: TaskState): Promise<RecoveryPoint> => {
    const head = (await runCommand({ command: "git", arguments: ["rev-parse", "HEAD"], cwd: fixture.repositoryPath })).stdout.trim();
    const status = (await runCommand({ command: "git", arguments: ["status", "--porcelain=v1"], cwd: fixture.repositoryPath })).stdout.trim();
    return createRecoveryPoint({ recoveryPointId: `recovery-${state.taskId}`, taskId: state.taskId, trigger: state.contextManifest.some((entry) => entry.startsWith("handoff-source:")) ? "handoff" : "recovery", stage: state.stage, environment: state.environment, role: state.role, head, branch: fixture.branch, workspacePath: fixture.repositoryPath, status: status || "clean", binaryPatch: "no patch required", stateManifest: state.durableContext!, verificationResults: state.verificationEvidence, createdAt: new Date().toISOString() }).recoveryPoint;
  };
  const dependencies: DAIRuntimeDependencies = {
    store, workspacePath: fixture.repositoryPath, repositoryPath: fixture.repositoryPath, skillRoots: [fixture.skillLibrary.rootPath], modelPolicies: [{ stage: "execute", role: "implementer", model: "codex-default", requiredCapabilities: ["local-execution"], compatibleEnvironments: ["codex"] }], adapters, handoffService: handoffs, bootstrapTask: bootstrap,
    selectEnvironment: (await import("../../src/routing/environment-router.js")).selectEnvironment,
    resolveModelRoute: (await import("../../src/routing/model-router.js")).resolveModelRoute,
    discoverSkillMetadata, selectCapabilities,
    loadSelectedSkill: async (descriptor, resources) => { trace.requestedResources.push({ name: descriptor.name, resources: [...resources] }); const skill = await loadSelectedSkill(descriptor, resources); trace.loadedSkills.push(skill); return skill; },
    evaluateHardGates, captureRecoveryPoint, createDebugSession: () => ({ phase: "reproduce", hypothesis: null, originalFailure: "fixture", preservedRecoveryPointId: "fixture", recoveryPointId: "fixture" }), recover: async (state) => { await rm(fixture.recoveryMarkerPath); return { ...state, stage: "recover", role: "recovery-operator" }; },
    closeTask: async (state): Promise<CloseVerdict> => closeTask(state, { store, gitHub: localGitHubAdapter(fixture) }), maximumEvidenceAgeMs: 300_000, now: () => new Date(),
  };
  Object.defineProperty(trace, "failedResult", { get: () => failedResult });
  Object.defineProperty(trace, "passingResult", { get: () => passingResult });
  Object.defineProperty(trace, "regressionResult", { get: () => regressionResult });
  return { runtime: createDAIRuntime(dependencies), store, handoffs, trace };
}

async function runLifecycle(fixture: KnownGoodRepositoryFixture): Promise<RuntimeFixture> {
  const runtimeFixture = await makeRuntimeFixture(fixture);
  const send = (command: Parameters<RuntimeFixture["runtime"]>[0]["command"], sourceEnvironment: Environment) => runtimeFixture.runtime({ command, sourceEnvironment, overrides: noOverrides });
  const record = async (response: Awaited<ReturnType<RuntimeFixture["runtime"]>>): Promise<void> => { runtimeFixture.trace.responses.push({ taskId: response.taskId, stage: response.stage, environment: response.environment, status: response.status, message: response.message }); };
  const intent = await send({ kind: "intent", text: "implement verify repository" }, "chat"); await record(intent);
  if (intent.status !== "blocked") throw new Error(`Intent unexpectedly completed: ${intent.message}`);
  const continued = await send({ kind: "continue", taskIdOrProject: intent.taskId }, "codex"); await record(continued);
  if (continued.status !== "completed") throw new Error(`Resume blocked: ${continued.message}`);
  const status = await send({ kind: "status" }, "codex"); await record(status);
  const handoff = await send({ kind: "handoff", target: "work" }, "codex"); await record(handoff);
  if (handoff.status !== "accepted") throw new Error(`Handoff blocked: ${handoff.message}`);
  runtimeFixture.trace.handoffSnapshots.push(runtimeFixture.handoffs.status(`handoff-${intent.taskId}-1`));
  const completedHandoff = await send({ kind: "complete", handoffId: `handoff-${intent.taskId}-1` }, "work"); await record(completedHandoff);
  runtimeFixture.trace.handoffSnapshots.push(runtimeFixture.handoffs.status(`handoff-${intent.taskId}-1`));
  const closeAttempt = await send({ kind: "close" }, "work"); await record(closeAttempt);
  return runtimeFixture;
}

describe("D-AI V1 end-to-end contract", { timeout: 20_000 }, () => {
  it("keeps the zero-configuration handle fail-closed and proves the injectable public factory boundary", async () => {
    const result = await handleDAIRequest({ command: { kind: "status" }, sourceEnvironment: "chat", overrides: noOverrides });
    expect(result).toMatchObject({ status: "blocked", taskId: "unassigned", environment: "chat" });
  });

  it("drives intent, continue, status, and handoff through the configured public runtime with one task and durable files", async () => {
    const fixture = await createKnownGoodRepository();
    try {
      const result = await runLifecycle(fixture);
      expect(new Set(result.trace.responses.map((response) => response.taskId)).size).toBe(1);
      expect(result.trace.responses.map((response) => response.stage)).toEqual(["recover", "verify", "verify", "handoff", "verify", "close"]);
      expect(result.trace.responses[0]).toMatchObject({ status: "blocked", environment: "codex" });
      expect(result.trace.responses.at(-2), result.trace.responses.at(-2)?.message).toMatchObject({ taskId: result.trace.responses[0]?.taskId, stage: "verify", environment: "work", status: "completed" });
      expect(result.trace.responses.at(-1), result.trace.responses.at(-1)?.message).toMatchObject({ taskId: result.trace.responses[0]?.taskId, stage: "close", environment: "work", status: "completed" });
      expect(result.trace.handoffSnapshots).toEqual([
        { handoffId: `handoff-${result.trace.responses[0]?.taskId}-1`, taskId: result.trace.responses[0]?.taskId, target: "work", state: "active", reason: null, owner: "work" },
        { handoffId: `handoff-${result.trace.responses[0]?.taskId}-1`, taskId: result.trace.responses[0]?.taskId, target: "work", state: "completed", reason: "Completed by work", owner: "work" },
      ]);
      const records = await new PersistentHandoffService(new FileHandoffPersistence(fixture.handoffPersistencePath)).ready().then(async () => new FileHandoffPersistence(fixture.handoffPersistencePath).load());
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        envelope: { handoffId: `handoff-${result.trace.responses[0]?.taskId}-1`, taskId: result.trace.responses[0]?.taskId, targetEnvironment: "work" },
        owner: "work",
        state: "completed",
      });
      expect(records[0]?.envelope.taskId).toBe(result.trace.responses[0]?.taskId);
      expect(new Set(result.trace.loadedSkills.map((skill) => skill.descriptor.name))).toEqual(new Set(fixture.skillLibrary.selectedSkillNames));
      expect(result.trace.requestedResources).toEqual([
        ...fixture.skillLibrary.selectedSkillNames.map((name) => ({ name, resources: ["references/contract.md"] })),
        ...fixture.skillLibrary.selectedSkillNames.map((name) => ({ name, resources: ["references/contract.md"] })),
      ]);
      expect(result.trace.loadedSkills.every((skill) => skill.instructions.includes(skill.descriptor.name))).toBe(true);
      for (const skill of result.trace.loadedSkills) {
        expect(skill.loadedResources).toEqual([join(fixture.skillLibrary.rootPath, skill.descriptor.name, "references", "contract.md")]);
        const expectedResource = skill.descriptor.name === "repository-execution"
          ? "Use the repository-local command fixtures for execution evidence.\n"
          : "Require a zero exit code and retain the observed output.\n";
        expect(await readFile(skill.loadedResources[0]!, "utf8")).toBe(expectedResource);
      }
      expect(result.trace.loadedSkills.flatMap((skill) => [skill.instructions, ...skill.loadedResources])).not.toContain(expect.stringContaining(fixture.skillLibrary.unrelatedSkillName));
      expect(result.trace.failedResult.exitCode).toBe(23);
      expect(result.trace.passingResult.stdout).toBe("fixture command recovered\n");
      expect(result.trace.regressionResult.stdout).toBe("fixture verification passed\n");
      const finalState = await result.store.load(result.trace.responses[0]!.taskId);
      expect(finalState?.verificationHistory?.some((item) => item.evidenceId === "gate:failure-handling" && !item.passed)).toBe(true);
      expect(finalState?.verificationHistory?.some((item) => item.evidenceId === "gate:scope" && item.passed)).toBe(true);
      expect(new Set(finalState?.verificationEvidence.map((item) => item.evidenceId)).size).toBe(finalState?.verificationEvidence.length);
    } finally { await fixture.cleanup(); }
  });

  it("reports missing and failed applicable gate evidence instead of treating one operation as every gate", async () => {
    const fixture = await createKnownGoodRepository();
    try {
      const result = await runLifecycle(fixture);
      const state = await result.store.load(result.trace.responses[0]!.taskId);
      expect(state).not.toBeNull();
      const missing = evaluateHardGates({ state: { ...state!, verificationEvidence: state!.verificationEvidence.filter((item) => item.evidenceId !== "gate:quality") }, evidence: [], now: new Date(), maximumEvidenceAgeMs: 300_000 });
      expect(missing.find((item) => item.gate === "quality")?.passed).toBe(false);
      const failed = evaluateHardGates({ state: { ...state!, verificationEvidence: state!.verificationEvidence.map((item) => item.evidenceId === "gate:quality" ? { ...item, passed: false, exitCode: 1 } : item) }, evidence: [], now: new Date(), maximumEvidenceAgeMs: 300_000 });
      expect(failed.find((item) => item.gate === "quality")?.passed).toBe(false);
    } finally { await fixture.cleanup(); }
  });

  it("retains exact task ownership and durable records through handoff completion and close", async () => {
    const fixture = await createKnownGoodRepository();
    try {
      const result = await runLifecycle(fixture);
      expect(result.trace.responses.at(-1)?.status).toBe("completed");
      expect(result.trace.responses.at(-1)?.stage).toBe("close");
      const persisted = await result.store.load(result.trace.responses[0]!.taskId);
      expect(persisted?.taskId).toBe(result.trace.responses[0]!.taskId);
      expect(persisted?.stage).toBe("close");
      expect(persisted?.environment).toBe("work");
      expect(persisted?.handoffState).toBe("completed");
      expect(persisted?.durableContext).not.toBeNull();
    } finally { await fixture.cleanup(); }
  });

  it("blocks close when each declared recovery artifact hash is independently corrupted", async () => {
    const fixture = await createKnownGoodRepository();
    try {
      const result = await runLifecycle(fixture);
      const taskId = result.trace.responses[0]!.taskId;
      const state = await result.store.load(taskId);
      if (state === null || state.recoveryPoint === null || state.durableContext === null) throw new Error("Lifecycle did not persist recovery correspondence");
      expect(state.recoveryPoint.durablePaths).toEqual(state.durableContext.durablePaths);
      expect(state.recoveryPoint.durablePaths.some((path) => path.endsWith("state.json"))).toBe(true);
      expect(state.recoveryPoint.durablePaths.some((path) => path.endsWith("manifest.json"))).toBe(true);
      expect(state.recoveryPoint.durablePaths.some((path) => path.endsWith("recovery.json"))).toBe(true);
      const originalContents = new Map<string, string>();
      for (const path of state.recoveryPoint.durablePaths) originalContents.set(path, await readFile(path, "utf8"));
      for (const path of state.recoveryPoint.durablePaths) {
        await writeFile(path, `${originalContents.get(path)}corrupted`, "utf8");
        const verdict = await closeTask(state, { store: result.store, gitHub: localGitHubAdapter(fixture) });
        expect(verdict.status, path).toBe("BLOCKED");
        await writeFile(path, originalContents.get(path)!, "utf8");
      }
    } finally { await fixture.cleanup(); }
  });

  it.skipIf(process.env.D_AI_GITHUB_EXTERNAL_INTEGRATION === "1")("keeps the configured external GitHub lane explicitly skipped when credentials are not configured", () => {
    expect(process.env.D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED).not.toBe("1");
  });
});
