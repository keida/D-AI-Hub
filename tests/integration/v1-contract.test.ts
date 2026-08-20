import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandExecutionError, runCommand, type CommandResult } from "../../src/adapters/command-runner.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { GitHubCliAdapter, GitRemoteBlockedError, type GitHubAdapter, type GitPushEvidence, type RemoteState } from "../../src/adapters/github.js";
import { pushGitRef, readRemoteRef, type GitTransport } from "../../src/adapters/git.js";
import { bootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { closeTask } from "../../src/close/close-service.js";
import { advanceDebugSession, createDebugSession, setDebugHypothesis, type DebugSession } from "../../src/debugging/debug-session.js";
import { InvalidTaskStateError } from "../../src/domain/errors.js";
import type { CloseVerdict, DurableContextManifest, Environment, RecoveryPoint, Role, Stage, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { assertStageTransition } from "../../src/domain/transitions.js";
import { FileHandoffPersistence, PersistentHandoffService, type HandoffStatus } from "../../src/handoff/handoff-service.js";
import { createRecoveryPoint } from "../../src/recovery/recovery-point-service.js";
import type { EnvironmentExecutionRequest, EnvironmentExecutionResult } from "../../src/runtime/d-ai-runtime.js";
import { handleDAIRequest } from "../../src/runtime/d-ai-runtime.js";
import { discoverSkillMetadata, selectCapabilities } from "../../src/skills/registry.js";
import { loadSelectedSkill } from "../../src/skills/skill-loader.js";
import type { DurableContextStore } from "../../src/state/durable-context-store.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { evaluateHardGates, type GateName } from "../../src/verification/gates.js";
import { createKnownGoodRepository, type KnownGoodRepositoryFixture } from "./fixtures/known-good-repo.js";

const noOverrides = { model: null, role: null, environment: null } as const;
const closeGateNames = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "recovery",
  "handoff",
  "durable-context",
  "critical-unsaved-context",
] as const satisfies readonly GateName[];

interface LifecycleTrace {
  readonly debugPhases: DebugSession["phase"][];
  readonly failedResult: CommandResult;
  readonly passingResult: CommandResult;
  readonly regressionResult: CommandResult;
  readonly selectedSkills: readonly string[];
  readonly ownership: readonly HandoffStatus[];
}

interface CloseSnapshotStore extends DurableContextStore {
  readonly replace: (state: TaskState | null) => Promise<void>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function persist(store: FileDurableContextStore, state: TaskState): Promise<TaskState> {
  const manifest = await store.save({ ...state, durableContext: null });
  return { ...state, durableContext: manifest };
}

function moveState(state: TaskState, stage: Stage, environment: Environment, role: Role, capabilities: readonly string[]): TaskState {
  assertStageTransition(state.stage, stage);
  return {
    ...state,
    stage,
    environment,
    role,
    selectedCapabilities: [...capabilities],
    routingDecision: {
      stage,
      environment,
      role,
      selectedModel: `${environment}-${role}`,
      selectedCapabilities: [...capabilities],
      reason: `Task 10 ${stage} ownership`,
      overrideSource: "default",
    },
    durableContext: null,
  };
}

function verificationEvidence(
  state: TaskState,
  gate: GateName,
  recoveryPointId: string | null,
  result: CommandResult,
  recordedAt: string,
): VerificationEvidence {
  return {
    evidenceId: `gate:${gate}`,
    stage: "verify",
    environment: state.environment,
    role: "evidence-collector",
    selectedModel: state.routingDecision?.selectedModel ?? "codex-evidence-collector",
    command: [result.command, ...result.arguments].join(" "),
    observedOutput: result.stdout.trim() || result.stderr.trim(),
    exitCode: result.exitCode,
    interpretation: gate === "failure-handling" ? "The original failure was reproduced, isolated, recovered, and reverified" : `${gate} passed`,
    passed: result.exitCode === 0,
    recoveryPointId,
    recordedAt,
  };
}

function closeEvidence(state: TaskState, gate: GateName, passed: boolean, recordedAt: string): VerificationEvidence {
  return {
    evidenceId: `gate:${gate}`,
    stage: "close",
    environment: "work",
    role: "evidence-collector",
    selectedModel: state.routingDecision?.selectedModel ?? "work-evidence-collector",
    command: "Task 10 close preflight",
    observedOutput: passed ? `${gate} passed` : `${gate} failed`,
    exitCode: passed ? 0 : 1,
    interpretation: passed ? `${gate} passed` : `${gate} failed intentionally`,
    passed,
    recoveryPointId: "task-10-close-recovery",
    recordedAt,
  };
}

async function runExpectedFailure(fixture: KnownGoodRepositoryFixture): Promise<CommandResult> {
  try {
    await runCommand(fixture.failingCommand);
  } catch (error: unknown) {
    if (error instanceof CommandExecutionError) return error.result;
    throw error;
  }
  throw new InvalidTaskStateError("The Task 10 failing command unexpectedly passed");
}

function runDebugRecovery(failure: CommandResult): { readonly session: DebugSession; readonly phases: readonly DebugSession["phase"][] } {
  const phases: DebugSession["phase"][] = [];
  let session = createDebugSession(failure.stderr.trim(), "known-good-repository-head");
  phases.push(session.phase);
  session = advanceDebugSession(session);
  phases.push(session.phase);
  session = advanceDebugSession(session);
  phases.push(session.phase);
  session = advanceDebugSession(session);
  phases.push(session.phase);
  session = setDebugHypothesis(session, "The failing fixture command is the isolated boundary; recovery must select the passing command");
  session = advanceDebugSession(session);
  phases.push(session.phase);
  session = advanceDebugSession(session);
  phases.push(session.phase);
  return { session, phases };
}

async function createCloseSnapshotStore(filePath: string): Promise<CloseSnapshotStore> {
  await mkdir(join(filePath, ".."), { recursive: true });
  let state: TaskState | null = null;
  const replace = async (replacement: TaskState | null): Promise<void> => {
    state = replacement;
    await writeFile(filePath, `${JSON.stringify(replacement, null, 2)}\n`, "utf8");
  };
  await replace(null);
  return {
    replace,
    load: async (taskId: string): Promise<TaskState | null> => {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as TaskState | null;
      if (parsed !== null && parsed.taskId !== taskId) throw new InvalidTaskStateError(`Close snapshot task mismatch: ${taskId}`);
      return parsed;
    },
    save: async (nextState: TaskState): Promise<DurableContextManifest> => {
      await replace(nextState);
      if (nextState.durableContext === null) throw new InvalidTaskStateError("Close snapshot requires an explicit durable manifest");
      return nextState.durableContext;
    },
    recordCriticalUnsavedContext: async (taskId: string, items: readonly string[]): Promise<void> => {
      if (state === null || state.taskId !== taskId) throw new InvalidTaskStateError(`Close snapshot task is missing: ${taskId}`);
      await replace({ ...state, criticalUnsavedContext: [...items] });
    },
    clearCriticalUnsavedContext: async (taskId: string): Promise<void> => {
      if (state === null || state.taskId !== taskId) throw new InvalidTaskStateError(`Close snapshot task is missing: ${taskId}`);
      await replace({ ...state, criticalUnsavedContext: [] });
    },
  };
}

function logicalCloseState(fixture: KnownGoodRepositoryFixture, recordedAt: string): TaskState {
  const durablePaths = ["context.json", "evidence.json", "approval.json", "handoff.json", "recovery.json"];
  const hashes = Object.fromEntries(durablePaths.map((path, index) => [path, String(index + 1).repeat(64)]));
  const base: TaskState = {
    taskId: "task-10-v1-contract",
    goal: "implement verify repository",
    constraints: ["Use only the disposable Task 10 repository"],
    environment: "work",
    stage: "close",
    role: "evidence-collector",
    routingDecision: {
      stage: "close",
      environment: "work",
      role: "evidence-collector",
      selectedModel: "work-evidence-collector",
      selectedCapabilities: ["durable-context"],
      reason: "Work owns close coordination",
      overrideSource: "default",
    },
    selectedCapabilities: ["durable-context"],
    contextManifest: [
      `identity:repository:${fixture.repositoryPath}:${sha256(fixture.repositoryPath)}`,
      "remote:origin",
      `ref:${fixture.ref}`,
      "local-state:clean-required",
      `artifact:commit:${fixture.commitSha}`,
    ],
    handoffState: "completed",
    verificationEvidence: [],
    recoveryPoint: {
      recoveryPointId: "task-10-close-recovery",
      taskId: "task-10-v1-contract",
      stage: "close",
      environment: "work",
      role: "evidence-collector",
      durablePaths,
      hashes,
      restorationInstructions: "Restore the known-good Task 10 commit without deleting user work.",
      createdAt: recordedAt,
    },
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext: {
      manifestId: "task-10-close-manifest",
      taskId: "task-10-v1-contract",
      stage: "close",
      environment: "work",
      role: "evidence-collector",
      durablePaths,
      hashes,
      recoveryPointId: "task-10-close-recovery",
      recordedAt,
    },
  };
  return { ...base, verificationEvidence: closeGateNames.map((gate) => closeEvidence(base, gate, true, recordedAt)) };
}

function localBareGitHubAdapter(fixture: KnownGoodRepositoryFixture): GitHubCliAdapter {
  const transport: GitTransport = {
    pushRef: async (repositoryPath, _endpoint, ref, head) => pushGitRef(repositoryPath, fixture.bareRemotePath, ref, head),
    readRef: async (_repositoryPath, _endpoint, ref) => readRemoteRef(fixture.bareRemotePath, ref, null),
  };
  return GitHubCliAdapter.forTestTransport({ enterpriseHost: null }, transport);
}

function failedPushAdapter(fixture: KnownGoodRepositoryFixture): GitHubAdapter {
  return {
    pushExpectedCommit: async (): Promise<GitPushEvidence> => ({
      remote: "origin",
      repository: "github.com/d-ai-contract/known-good",
      ref: fixture.ref,
      localSha: fixture.commitSha,
      pushed: false,
      observedOutput: "authentication failed",
      exitCode: 128,
      failureCategory: "authentication",
    }),
    verifyRemoteState: async (): Promise<RemoteState> => {
      throw new Error("Remote verification must not run after failed push evidence");
    },
  };
}

function mismatchedRemoteAdapter(fixture: KnownGoodRepositoryFixture): GitHubAdapter {
  return {
    pushExpectedCommit: async (): Promise<GitPushEvidence> => ({
      remote: "origin",
      repository: "github.com/d-ai-contract/known-good",
      ref: fixture.ref,
      localSha: fixture.commitSha,
      pushed: true,
      observedOutput: "push completed",
      exitCode: 0,
      failureCategory: null,
    }),
    verifyRemoteState: async (): Promise<RemoteState> => ({
      repository: "github.com/d-ai-contract/known-good",
      ref: fixture.ref,
      remoteSha: "f".repeat(40),
      matchesExpectedSha: false,
    }),
  };
}

async function executeLifecycle(fixture: KnownGoodRepositoryFixture): Promise<{ readonly state: TaskState; readonly trace: LifecycleTrace }> {
  const store = new FileDurableContextStore(fixture.durableContextRoot);
  const handoffService = new PersistentHandoffService(new FileHandoffPersistence(fixture.handoffPersistencePath));
  const ownership: HandoffStatus[] = [];
  const debugPhases: DebugSession["phase"][] = [];
  let failedResult: CommandResult | null = null;
  let passingResult: CommandResult | null = null;
  let regressionResult: CommandResult | null = null;
  const executor = async (request: EnvironmentExecutionRequest): Promise<EnvironmentExecutionResult> => {
    failedResult = await runExpectedFailure(fixture);
    const debug = runDebugRecovery(failedResult);
    debugPhases.push(...debug.phases);
    passingResult = await runCommand(fixture.passingCommand);
    let session = advanceDebugSession(debug.session);
    debugPhases.push(session.phase);
    regressionResult = await runCommand(fixture.passingCommand);
    session = advanceDebugSession(session);
    debugPhases.push(session.phase);
    const recordedAt = new Date().toISOString();
    return {
      status: "completed",
      evidence: closeGateNames
        .filter((gate) => gate !== "handoff")
        .map((gate) => verificationEvidence(request.state, gate, null, passingResult!, recordedAt)),
      message: "Execution recovered and verification passed",
    };
  };
  const chat = new ChatEnvironmentAdapter(handoffService, executor);
  const work = new WorkEnvironmentAdapter(handoffService, executor);
  const codex = new CodexEnvironmentAdapter(handoffService, executor);

  const goal = "implement verify repository";
  let state = await bootstrapTask({
    taskId: null,
    goal,
    environment: "chat",
    workspacePath: null,
    repositoryPath: fixture.repositoryPath,
  }, store);
  state = await persist(store, {
    ...moveState(state, "route", "chat", "planner", ["approval", "status"]),
    constraints: ["Use only the disposable Task 10 repository"],
  });

  const chatToWork = await handoffService.create({ state: { ...state, handoffState: "none" }, targetEnvironment: "work" });
  await work.receive(chatToWork);
  ownership.push(handoffService.status(chatToWork.handoffId));
  await work.complete(chatToWork.handoffId);
  state = await persist(store, {
    ...moveState(state, "plan", "work", "planner", ["durable-context"]),
    handoffState: "none",
    contextManifest: [...state.contextManifest, `handoff:${chatToWork.handoffId}:completed`],
  });

  const workToCodex = await handoffService.create({ state, targetEnvironment: "codex" });
  await codex.receive(workToCodex);
  ownership.push(handoffService.status(workToCodex.handoffId));
  await codex.complete(workToCodex.handoffId);
  state = await persist(store, {
    ...moveState(state, "execute", "codex", "implementer", ["local-execution"]),
    handoffState: "none",
    contextManifest: [...state.contextManifest, `handoff:${workToCodex.handoffId}:completed`],
  });

  const descriptors = await discoverSkillMetadata([fixture.skillLibrary.rootPath]);
  const selected = selectCapabilities(goal, "execute", "codex", descriptors);
  const skills = await Promise.all(selected.map((descriptor) => loadSelectedSkill(descriptor, [])));
  const execution = await codex.execute({ state, skills });
  if (execution.status !== "completed") throw new InvalidTaskStateError(`Task 10 execution did not recover: ${execution.message}`);
  state = await persist(store, {
    ...moveState(state, "inspect", "codex", "evidence-collector", ["local-execution"]),
    verificationEvidence: execution.evidence,
  });
  state = await persist(store, moveState(state, "verify", "codex", "evidence-collector", ["local-execution"]));
  const gitHead = (await runCommand({ command: "git", arguments: ["rev-parse", "HEAD"], cwd: fixture.repositoryPath })).stdout.trim();
  const gitStatus = (await runCommand({ command: "git", arguments: ["status", "--porcelain=v1"], cwd: fixture.repositoryPath })).stdout.trim();
  const createdAt = new Date().toISOString();
  if (state.durableContext === null) throw new InvalidTaskStateError("Verify state was not durably persisted");
  const captured = createRecoveryPoint({
    recoveryPointId: `recovery-${state.taskId}`,
    taskId: state.taskId,
    trigger: "recovery",
    stage: state.stage,
    environment: state.environment,
    role: state.role,
    head: gitHead,
    branch: fixture.branch,
    workspacePath: fixture.repositoryPath,
    status: gitStatus.length === 0 ? "clean" : gitStatus,
    binaryPatch: "no patch required",
    stateManifest: state.durableContext,
    verificationResults: state.verificationEvidence,
    createdAt,
  });
  state = await persist(store, {
    ...state,
    verificationEvidence: state.verificationEvidence.map((evidence) => ({ ...evidence, recoveryPointId: captured.recoveryPoint.recoveryPointId })),
    recoveryPoint: captured.recoveryPoint,
  });
  const gateResults = evaluateHardGates({
    state,
    evidence: state.verificationEvidence.map((verification) => ({ gate: verification.evidenceId.slice("gate:".length) as GateName, verification })),
    now: new Date(),
    maximumEvidenceAgeMs: 300_000,
  });
  expect(gateResults.filter((result) => closeGateNames.includes(result.gate as typeof closeGateNames[number]) && result.gate !== "handoff").every((result) => result.passed)).toBe(true);

  await store.recordCriticalUnsavedContext(state.taskId, ["Codex failure evidence must be transferred to Work"]);
  state = await store.load(state.taskId) ?? state;
  const codexToWork = await handoffService.create({ state: { ...state, handoffState: "none" }, targetEnvironment: "work" });
  await work.receive(codexToWork);
  ownership.push(handoffService.status(codexToWork.handoffId));
  await work.complete(codexToWork.handoffId);
  await store.clearCriticalUnsavedContext(state.taskId);
  state = await store.load(state.taskId) ?? state;

  if (failedResult === null || passingResult === null || regressionResult === null) {
    throw new InvalidTaskStateError("Task 10 command lifecycle did not produce complete evidence");
  }
  return {
    state,
    trace: {
      debugPhases,
      failedResult,
      passingResult,
      regressionResult,
      selectedSkills: skills.map((skill) => skill.descriptor.name),
      ownership,
    },
  };
}

describe("D-AI V1 end-to-end contract", () => {
  it("keeps the public handle fail-closed when no task or connector is configured", async () => {
    const result = await handleDAIRequest({ command: { kind: "status" }, sourceEnvironment: "chat", overrides: noOverrides });

    expect(result).toMatchObject({ status: "blocked", taskId: "unassigned", environment: "chat" });
    expect(result.message).toMatch(/no active task/i);
  });

  it("preserves one task and one owner through Chat, Work, Codex, recovery, verification, and durable Work transfer", async () => {
    const fixture = await createKnownGoodRepository();
    try {
      const result = await executeLifecycle(fixture);

      expect(result.state.taskId).toMatch(/^task-/);
      expect(result.trace.ownership.map((status) => status.owner)).toEqual(["work", "codex", "work"]);
      expect(result.trace.ownership.every((status) => status.state === "active")).toBe(true);
      expect(result.trace.failedResult.exitCode).toBe(23);
      expect(result.trace.failedResult.stderr).toContain("intentional fixture failure");
      expect(result.trace.debugPhases).toEqual(["reproduce", "capture", "isolate", "hypothesize", "change", "reverify", "regress", "stop"]);
      expect(result.trace.passingResult).toMatchObject({ exitCode: 0, stdout: "fixture verification passed\n" });
      expect(result.trace.regressionResult.exitCode).toBe(0);
      expect(result.trace.selectedSkills).toEqual(fixture.skillLibrary.selectedSkillNames);
      expect(result.trace.selectedSkills).not.toContain(fixture.skillLibrary.unrelatedSkillName);
      expect(result.state.criticalUnsavedContext).toEqual([]);
      expect(result.state.durableContext?.durablePaths.every((path) => path.startsWith(fixture.durableContextRoot))).toBe(true);
      const persistedHandoffs = await new FileHandoffPersistence(fixture.handoffPersistencePath).load();
      expect(persistedHandoffs.some((record) => record.envelope.taskId === result.state.taskId)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects every unmet close prerequisite before exact local bare-remote verification can return YES", async () => {
    const fixture = await createKnownGoodRepository();
    try {
      const recordedAt = new Date().toISOString();
      const ready = logicalCloseState(fixture, recordedAt);
      const snapshotStore = await createCloseSnapshotStore(join(fixture.repositoryPath, ".d-ai", "close-contract", "state.json"));
      const runClose = async (state: TaskState, gitHub: GitHubAdapter): Promise<CloseVerdict> => {
        await snapshotStore.replace(state);
        return closeTask(state, { store: snapshotStore, gitHub });
      };

      const missingDurable = await runClose({ ...ready, durableContext: null }, localBareGitHubAdapter(fixture));
      expect(missingDurable.status).not.toBe("YES");
      expect(missingDurable.reasons.join(" ")).toMatch(/durable context manifest is missing/i);

      const unsaved = await runClose({ ...ready, criticalUnsavedContext: ["unpersisted failure evidence"] }, localBareGitHubAdapter(fixture));
      expect(unsaved.status).not.toBe("YES");
      expect(unsaved.reasons.join(" ")).toMatch(/critical unsaved context remains/i);

      const failedQualityState = {
        ...ready,
        verificationEvidence: ready.verificationEvidence.map((evidence) => evidence.evidenceId === "gate:quality"
          ? closeEvidence(ready, "quality", false, recordedAt)
          : evidence),
      };
      const failedQuality = await runClose(failedQualityState, localBareGitHubAdapter(fixture));
      expect(failedQuality.status).not.toBe("YES");
      expect(failedQuality.reasons.join(" ")).toMatch(/hard gate quality failed/i);

      const failedPush = await runClose(ready, failedPushAdapter(fixture));
      expect(failedPush.status).not.toBe("YES");
      expect(failedPush.evidence.some((evidence) => evidence.evidenceId === "close:git-push" && !evidence.passed)).toBe(true);

      const mismatchedRemote = await runClose(ready, mismatchedRemoteAdapter(fixture));
      expect(mismatchedRemote.status).not.toBe("YES");
      expect(mismatchedRemote.evidence.some((evidence) => evidence.evidenceId === "close:remote-sha" && !evidence.passed)).toBe(true);

      const verified = await runClose(ready, localBareGitHubAdapter(fixture));
      expect(verified).toMatchObject({ status: "YES", reasons: [] });
      expect(verified.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ evidenceId: "close:git-push", passed: true, exitCode: 0 }),
        expect.objectContaining({ evidenceId: "close:remote-sha", passed: true, exitCode: 0 }),
      ]));
      const remoteSha = (await runCommand({ command: "git", arguments: ["rev-parse", fixture.ref], cwd: fixture.bareRemotePath })).stdout.trim();
      expect(remoteSha).toBe(fixture.commitSha);
      expect(ready.criticalUnsavedContext).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps the external GitHub lane opt-in and reports missing credentials as BLOCKED", async () => {
    const fixture = await createKnownGoodRepository();
    try {
      const ready = logicalCloseState(fixture, new Date().toISOString());
      const snapshotStore = await createCloseSnapshotStore(join(fixture.repositoryPath, ".d-ai", "external-close", "state.json"));
      await snapshotStore.replace(ready);
      const externalLaneConfigured = process.env.D_AI_GITHUB_EXTERNAL_INTEGRATION === "1"
        && process.env.D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED === "1";
      const blockedExternalAdapter: GitHubAdapter = {
        pushExpectedCommit: async (): Promise<GitPushEvidence> => {
          throw new GitRemoteBlockedError(externalLaneConfigured
            ? "Task 10 external lane is intentionally not invoked by the default suite"
            : "Task 10 external GitHub credentials or opt-in configuration are missing");
        },
        verifyRemoteState: async (): Promise<RemoteState> => {
          throw new Error("Remote verification must not run when the external lane is blocked");
        },
      };

      const verdict = await closeTask(ready, { store: snapshotStore, gitHub: blockedExternalAdapter });

      expect(verdict.status).toBe("BLOCKED");
      expect(verdict.reasons.join(" ")).toMatch(/external|credential|opt-in|blocked/i);
      expect(verdict.evidence.some((evidence) => evidence.evidenceId === "close:git-push" && evidence.passed)).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});
