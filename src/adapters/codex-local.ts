import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { runCommand, redactSensitiveText } from "./command-runner.js";
import { inspectCurrentGitState, summarizeLocalGitState } from "./git.js";
import { resolveGitHubRepository } from "./github.js";
import { createRecoveryPoint } from "../recovery/recovery-point-service.js";
import { containsSecretShapedValue } from "../domain/manifest-id.js";
import type { EnvironmentExecutionRequest, EnvironmentExecutionResult, EnvironmentExecutor } from "../runtime/d-ai-runtime.js";
import type { CapturedRecoveryPoint } from "../recovery/recovery-point-service.js";
import type { TaskState, VerificationEvidence } from "../domain/types.js";

const executionGates = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "durable-context",
  "critical-unsaved-context",
] as const;

function boundedGoal(request: EnvironmentExecutionRequest): boolean {
  return /\bverify\b/i.test(request.state.goal) && request.skills.length > 0;
}

function evidenceFor(
  request: EnvironmentExecutionRequest,
  evidenceId: string,
  observedOutput: string,
  now: string,
  passed: boolean,
  exitCode: number,
): VerificationEvidence {
  const selectedModel = request.state.routingDecision?.selectedModel;
  if (selectedModel === undefined || selectedModel.trim().length === 0) {
    throw new Error("Codex verification requires a selected model");
  }
  return {
    evidenceId,
    stage: "verify",
    environment: request.state.environment,
    role: "evidence-collector",
    selectedModel,
    command: evidenceId === "gate:quality" ? "git diff --check" : "d-ai bounded verification precondition",
    observedOutput,
    exitCode,
    interpretation: passed ? "Observed bounded local verification passed" : "Observed bounded local verification failed",
    passed,
    recoveryPointId: null,
    recordedAt: now,
  };
}

function contextEntries(branch: string, remote: string, ref: string, head: string, repository: string | null): readonly string[] {
  return [
    `branch:${branch}`,
    `remote:${remote}`,
    `ref:${ref}`,
    `artifact:commit:${head}`,
    "local-state:clean-required",
    ...(repository === null ? [] : [`remote-repository:${repository}`]),
  ];
}

function identityPath(state: TaskState, kind: "workspace" | "repository"): string | undefined {
  const prefix = `identity:${kind}:`;
  const entries = state.contextManifest.filter((entry) => entry.startsWith(prefix));
  if (entries.length !== 1) return undefined;
  const match = new RegExp(`^identity:${kind}:(.+):[a-f0-9]{64}$`, "i").exec(entries[0]!);
  return match?.[1];
}

async function pathsResolveToSameRepository(expectedPath: string, actualPath: string): Promise<boolean> {
  try {
    return (await realpath(expectedPath)) === (await realpath(actualPath));
  } catch {
    return false;
  }
}

function oneRemoteRepositoryIdentity(state: TaskState): string | undefined {
  const entries = state.contextManifest.filter((entry) => entry.startsWith("remote-repository:"));
  return entries.length === 1 ? entries[0]?.slice("remote-repository:".length) : undefined;
}

export function createCodexExecutionAdapter(now: () => Date = () => new Date()): EnvironmentExecutor {
  return async (request): Promise<EnvironmentExecutionResult> => {
    const selectedSkill = request.skills.find((skill) => skill.descriptor.triggers.includes("verify"));
    if (!boundedGoal(request) || selectedSkill === undefined || selectedSkill.instructions.trim().length === 0) {
      return {
        status: "blocked",
        evidence: [],
        message: "No safe bounded Codex verification operation is configured for this intent",
      };
    }

    const repositoryPath = identityPath(request.state, "repository");
    const workspacePath = identityPath(request.state, "workspace");
    if (repositoryPath === undefined || workspacePath === undefined) {
      return { status: "blocked", evidence: [], message: "Codex verification requires exactly one persisted workspace and repository identity" };
    }

    let local;
    try {
      local = await inspectCurrentGitState(workspacePath, "origin");
    } catch (error: unknown) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      return { status: "blocked", evidence: [], message: `Codex verification could not resolve the configured Git repository: ${message}` };
    }
    if (!(await pathsResolveToSameRepository(repositoryPath, local.repositoryPath))) {
      return { status: "blocked", evidence: [], message: "Codex verification repository identity does not match the inspected Git root" };
    }
    let actualRemoteRepository: string;
    try {
      actualRemoteRepository = resolveGitHubRepository(local.remoteUrl, process.env.D_AI_GITHUB_EXTERNAL_ENTERPRISE_HOST ?? null).repository;
    } catch (error: unknown) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      return { status: "blocked", evidence: [], message: `Codex verification requires a configured GitHub remote identity: ${message}` };
    }
    if (oneRemoteRepositoryIdentity(request.state) !== actualRemoteRepository) {
      return { status: "blocked", evidence: [], message: "Codex verification remote repository identity does not match the inspected Git remote" };
    }
    if (local.worktreeStatus.length > 0) {
      return { status: "blocked", evidence: [], message: "Codex verification requires a clean worktree" };
    }
    const diffCheck = await runCommand({ command: "git", arguments: ["diff", "--check"], cwd: local.repositoryPath, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
    const recordedAt = now().toISOString();
    const observed = summarizeLocalGitState(local);
    const checks: Readonly<Record<(typeof executionGates)[number], boolean>> = {
      scope: request.state.constraints.length > 0 && /\bverify\b/i.test(request.state.goal),
      "environment-capability": request.state.selectedCapabilities.includes("local-execution")
        && request.state.routingDecision !== null
        && request.state.routingDecision.selectedModel.trim().length > 0,
      "task-state": request.state.taskId.trim().length > 0 && request.state.stage === "execute",
      quality: local.worktreeStatus.length === 0 && diffCheck.exitCode === 0,
      "failure-handling": request.state.verificationEvidence.every((item) => item.passed),
      "durable-context": request.state.durableContext !== null,
      "critical-unsaved-context": request.state.criticalUnsavedContext.length === 0,
    };
    const failedGate = executionGates.find((gate) => !checks[gate]);
    if (failedGate !== undefined) {
      return { status: "blocked", evidence: [], message: `Codex bounded verification precondition failed for ${failedGate}` };
    }
    const observations: Readonly<Record<(typeof executionGates)[number], string>> = {
      scope: `Recorded ${request.state.constraints.length} task constraints for bounded verification`,
      "environment-capability": `Selected capability set: ${request.state.selectedCapabilities.join(", ")}`,
      "task-state": `Task ${request.state.taskId} is executing in ${request.state.environment}`,
      quality: `${observed}\nGit diff check exit code: ${diffCheck.exitCode ?? -1}`,
      "failure-handling": `Recorded failed verification count: ${request.state.verificationEvidence.filter((item) => !item.passed).length}`,
      "durable-context": `Durable context manifest present: ${request.state.durableContext !== null}`,
      "critical-unsaved-context": `Critical unsaved context count: ${request.state.criticalUnsavedContext.length}`,
    };
    const evidence = executionGates.map((gate) => evidenceFor(request, `gate:${gate}`, observations[gate], recordedAt, checks[gate], gate === "quality" ? diffCheck.exitCode ?? -1 : 0));
    return {
      status: "completed",
      evidence,
      contextManifestEntries: contextEntries(local.branch, local.remote, local.ref, local.head, actualRemoteRepository),
      message: `Codex bounded verification completed for ${request.state.taskId}`,
    };
  };
}

export function createCodexRecoveryPointCapture(now: () => Date = () => new Date()): (state: TaskState) => Promise<CapturedRecoveryPoint> {
  return async (state): Promise<CapturedRecoveryPoint> => {
    const repositoryPath = identityPath(state, "repository");
    const workspacePath = identityPath(state, "workspace");
    if (repositoryPath === undefined || workspacePath === undefined) {
      throw new Error("Codex recovery capture requires exactly one persisted workspace and repository identity");
    }
    if (state.durableContext === null) {
      throw new Error("Codex recovery capture requires durable context");
    }
    const local = await inspectCurrentGitState(workspacePath, "origin");
    if (!(await pathsResolveToSameRepository(repositoryPath, local.repositoryPath))) {
      throw new Error("Codex recovery repository identity does not match the inspected Git root");
    }
    let actualRemoteRepository: string;
    try {
      actualRemoteRepository = resolveGitHubRepository(local.remoteUrl, process.env.D_AI_GITHUB_EXTERNAL_ENTERPRISE_HOST ?? null).repository;
    } catch (error: unknown) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      throw new Error(`Codex recovery requires a configured GitHub remote identity: ${message}`);
    }
    if (oneRemoteRepositoryIdentity(state) !== actualRemoteRepository) {
      throw new Error("Codex recovery remote repository identity does not match the inspected Git remote");
    }
    if (local.worktreeStatus.length > 0) {
      throw new Error("Codex recovery capture refused because a complete staged, unstaged, or untracked snapshot is unavailable");
    }
    const diff = await runCommand({ command: "git", arguments: ["diff", "--binary", "HEAD"], cwd: local.repositoryPath, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
    const binaryPatch = redactSensitiveText(diff.stdout);
    if (containsSecretShapedValue(binaryPatch)) {
      throw new Error("Codex recovery capture refused secret-like patch content");
    }
    return createRecoveryPoint({
      recoveryPointId: randomUUID(),
      taskId: state.taskId,
      trigger: "risky-work",
      stage: state.stage,
      environment: state.environment,
      role: state.role,
      head: local.head,
      branch: local.branch,
      workspacePath,
      status: local.worktreeStatus.length === 0 ? "clean" : local.worktreeStatus,
      binaryPatch,
      stateManifest: state.durableContext,
      verificationResults: state.verificationEvidence,
      createdAt: now().toISOString(),
    });
  };
}

export type CodexRecoveryPointCapture = ReturnType<typeof createCodexRecoveryPointCapture>;
