import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CommandExecutionError, redactSensitiveText, runCommand, type CommandResult } from "../adapters/command-runner.js";
import { InvalidTaskStateError, TaskOwnershipError } from "../domain/errors.js";
import { literalExcludePathspec, resolveGitRepositoryRoot } from "../adapters/git.js";
import type { TaskOwnershipGuard, TaskOwnershipLease } from "../state/durable-context-store.js";
import type { CapturedRecoveryPoint } from "./recovery-point-service.js";
import { RollbackPartialFailureError, safeRollback, type AuditableGitAction, type RollbackResult } from "./rollback.js";
import type { TaskState } from "../domain/types.js";

const rollbackCommandTimeoutMs = 30_000;
const rollbackCommandMaxOutputBytes = 1_048_576;

function action(result: CommandResult): AuditableGitAction {
  return {
    command: result.command,
    arguments: result.arguments,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

async function git(repositoryPath: string, argumentsList: readonly string[]): Promise<CommandResult> {
  return runCommand({
    command: "git",
    arguments: argumentsList,
    cwd: repositoryPath,
    timeoutMs: rollbackCommandTimeoutMs,
    maxOutputBytes: rollbackCommandMaxOutputBytes,
  });
}

async function gitAllowFailure(repositoryPath: string, argumentsList: readonly string[]): Promise<CommandResult> {
  try {
    return await git(repositoryPath, argumentsList);
  } catch (error: unknown) {
    if (error instanceof CommandExecutionError) return error.result;
    throw error;
  }
}

function failedPreserveAction(error: unknown): AuditableGitAction | null {
  return error instanceof CommandExecutionError ? action(error.result) : null;
}

function output(result: CommandResult): string {
  return result.stdout.trim();
}

function capturedPoint(state: TaskState): CapturedRecoveryPoint {
  if (state.recoveryPoint === null || state.recoverySnapshot === null || state.recoverySnapshot === undefined) {
    throw new Error(`Task ${state.taskId} has no complete recovery point`);
  }
  return { trigger: "recovery", recoveryPoint: state.recoveryPoint, snapshot: state.recoverySnapshot };
}

function patchDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function durablePathSpec(repositoryPath: string, workspacePath: string): string {
  const workspaceRelativePath = relative(repositoryPath, resolve(workspacePath)).replaceAll("\\", "/");
  return workspaceRelativePath.length === 0 ? ".d-ai" : `${workspaceRelativePath}/.d-ai`;
}

function persistedRepositoryIdentityPath(contextManifest: readonly string[]): string | null {
  const entries = contextManifest.filter((entry) => entry.startsWith("identity:repository:"));
  if (entries.length !== 1) return null;
  const payload = entries[0]!.slice("identity:repository:".length);
  const separator = payload.lastIndexOf(":");
  if (separator <= 0 || !/^[a-f0-9]{64}$/i.test(payload.slice(separator + 1))) return null;
  return payload.slice(0, separator);
}

async function canonicalPath(path: string): Promise<string | null> {
  try {
    return await realpath(resolve(path));
  } catch {
    return null;
  }
}

async function sameRepositoryPath(left: string, right: string): Promise<boolean> {
  const [leftCanonical, rightCanonical] = await Promise.all([canonicalPath(left), canonicalPath(right)]);
  if (leftCanonical === null || rightCanonical === null) return false;
  return process.platform === "win32"
    ? leftCanonical.toLowerCase() === rightCanonical.toLowerCase()
    : leftCanonical === rightCanonical;
}

function createAdapter(repositoryPath: string, workspacePath: string, assertOwnership: TaskOwnershipGuard) {
  const durablePath = durablePathSpec(repositoryPath, workspacePath);
  return {
    async preserveUncommittedWork() {
      await assertOwnership();
      const marker = `d-ai-rollback-${randomUUID()}`;
      const stash = await git(repositoryPath, ["stash", "push", "--include-untracked", "--message", marker, "--", ".", literalExcludePathspec(durablePath)]);
      if (/no local changes to save/i.test(stash.stdout)) {
        return { archiveId: `clean-worktree:${marker}`, patchDigest: patchDigest("") };
      }
      const stashAction = action(stash);
      try {
        await assertOwnership();
        const archiveId = output(await git(repositoryPath, ["rev-parse", "stash@{0}"]));
        await assertOwnership();
        const archive = await git(repositoryPath, ["show", "--format=", "--binary", archiveId]);
        return { archiveId, patchDigest: patchDigest(archive.stdout) };
      } catch (error: unknown) {
        if (error instanceof TaskOwnershipError) {
          const message = redactSensitiveText(error.message);
          throw new RollbackPartialFailureError(
            {
              preservedUserWork: { archiveId: `preserve-pending:${marker}`, patchDigest: "0".repeat(64) },
              actions: [stashAction],
              verification: { passed: false, observedOutput: "", reason: `Preserve stage ownership was lost after Git mutation: ${message}` },
            },
            message,
          );
        }
        const failedAction = failedPreserveAction(error);
        const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
        throw new RollbackPartialFailureError(
          {
            preservedUserWork: { archiveId: `preserve-failed:${marker}`, patchDigest: "0".repeat(64) },
            actions: failedAction === null ? [stashAction] : [stashAction, failedAction],
            verification: { passed: false, observedOutput: "", reason: `Preserve stage failed: ${message}` },
          },
          `Preserve stage failed: ${message}`,
        );
      }
    },
    async revertCommit(commit: string) {
      await assertOwnership();
      return action(await git(repositoryPath, ["revert", "--no-edit", commit]));
    },
    async restoreRecoveryPatch(binaryPatch: string) {
      await assertOwnership();
      const temporaryRoot = await mkdtemp(join(tmpdir(), "d-ai-recovery-patch-"));
      const patchPath = join(temporaryRoot, "recovery.patch");
      try {
        await writeFile(patchPath, binaryPatch, "utf8");
        await assertOwnership();
        return action(await git(repositoryPath, ["apply", "--binary", "--allow-empty", patchPath]));
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    async verifyRecoveryPoint(recoveryPoint: CapturedRecoveryPoint) {
      await assertOwnership();
      const headResult = await git(repositoryPath, ["rev-parse", "HEAD"]);
      await assertOwnership();
      const branchResult = await git(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      await assertOwnership();
      const statusResult = await git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", literalExcludePathspec(durablePath)]);
      await assertOwnership();
      const treeResult = await gitAllowFailure(repositoryPath, ["diff", "--quiet", recoveryPoint.snapshot.head, "HEAD"]);
      await assertOwnership();
      const observedHead = output(headResult);
      const observedBranch = output(branchResult);
      const observedStatus = output(statusResult);
      const expectedStatus = recoveryPoint.snapshot.status === "clean" ? "" : recoveryPoint.snapshot.status;
      const passed = treeResult.exitCode === 0
        && observedBranch === recoveryPoint.snapshot.branch
        && observedStatus === expectedStatus;
      return {
        passed,
        observedOutput: `HEAD=${observedHead}; branch=${observedBranch}; status=${observedStatus || "clean"}`,
        reason: passed ? "Recovery tree, branch, and workspace verified" : `Recovery point mismatch: tree comparison exit=${treeResult.exitCode}; expected tree=${recoveryPoint.snapshot.head}, branch=${recoveryPoint.snapshot.branch}, status=${expectedStatus || "clean"}; observed HEAD=${observedHead}, branch=${observedBranch}, status=${observedStatus || "clean"}`,
      };
    },
  };
}

export function createGitRollbackTask(repositoryPath: string): (
  state: TaskState,
  lease: TaskOwnershipLease,
  assertOwnership?: TaskOwnershipGuard,
) => Promise<RollbackResult> {
  return async (state: TaskState, lease: TaskOwnershipLease, assertOwnership?: TaskOwnershipGuard): Promise<RollbackResult> => {
    if (assertOwnership === undefined) throw new TaskOwnershipError(`Rollback ownership guard is unavailable for task ${state.taskId}`);
    if (lease.taskId !== state.taskId || lease.environment !== state.environment) {
      throw new TaskOwnershipError(`Rollback ownership does not match task ${state.taskId}`);
    }
    if (state.rollbackAudit?.verification.passed === false) {
      throw new InvalidTaskStateError(`Task ${state.taskId} has a persisted partial rollback audit; manual reconciliation is required before retry`);
    }
    if (state.rollbackAudit?.verification.passed === true) {
      throw new InvalidTaskStateError(`Task ${state.taskId} has a completed rollback audit; the rollback is terminal and must not be retried`);
    }
    const point = capturedPoint(state);
    const repositoryRoot = await resolveGitRepositoryRoot(repositoryPath);
    const canonicalWorkspacePath = await canonicalPath(repositoryPath);
    if (canonicalWorkspacePath === null || !(await sameRepositoryPath(point.snapshot.workspacePath, repositoryPath))) {
      throw new Error("Recovery workspace does not match the configured workspace");
    }
    const expectedRepositoryPath = persistedRepositoryIdentityPath(state.contextManifest);
    if (expectedRepositoryPath === null || !(await sameRepositoryPath(expectedRepositoryPath, repositoryRoot))) {
      throw new InvalidTaskStateError(`Task ${state.taskId} repository identity does not match the resolved Git root`);
    }
    await assertOwnership();
    const currentHead = output(await git(repositoryRoot, ["rev-parse", "HEAD"]));
    await assertOwnership();
    const ancestry = await gitAllowFailure(repositoryRoot, ["merge-base", "--is-ancestor", point.snapshot.head, currentHead]);
    await assertOwnership();
    if (ancestry.exitCode !== 0) {
      throw new InvalidTaskStateError(`Recovery point ${point.snapshot.head} is not an ancestor of current HEAD ${currentHead}; rollback history is divergent`);
    }
    const commitsToRevert = currentHead === point.snapshot.head
      ? []
      : output(await git(repositoryRoot, ["rev-list", `${point.snapshot.head}..${currentHead}`])).split(/\r?\n/).filter((commit) => commit.length > 0);
    return safeRollback({ recoveryPoint: point, commitsToRevert, adapter: createAdapter(repositoryRoot, canonicalWorkspacePath, assertOwnership) });
  };
}
