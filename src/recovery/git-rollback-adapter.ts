import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutionError, runCommand, type CommandResult } from "../adapters/command-runner.js";
import { TaskOwnershipError } from "../domain/errors.js";
import type { TaskOwnershipGuard, TaskOwnershipLease } from "../state/durable-context-store.js";
import type { CapturedRecoveryPoint } from "./recovery-point-service.js";
import { safeRollback, type AuditableGitAction, type RollbackResult } from "./rollback.js";
import type { TaskState } from "../domain/types.js";

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
  return runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath });
}

async function gitAllowFailure(repositoryPath: string, argumentsList: readonly string[]): Promise<CommandResult> {
  try {
    return await git(repositoryPath, argumentsList);
  } catch (error: unknown) {
    if (error instanceof CommandExecutionError) return error.result;
    throw error;
  }
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

function createAdapter(repositoryPath: string, assertOwnership: TaskOwnershipGuard) {
  return {
    async preserveUncommittedWork() {
      await assertOwnership();
      const marker = `d-ai-rollback-${randomUUID()}`;
      const stash = await git(repositoryPath, ["stash", "push", "--include-untracked", "--message", marker]);
      if (/no local changes to save/i.test(stash.stdout)) {
        return { archiveId: `clean-worktree:${marker}`, patchDigest: patchDigest("") };
      }
      await assertOwnership();
      const archiveId = output(await git(repositoryPath, ["rev-parse", "stash@{0}"]));
      await assertOwnership();
      const archive = await git(repositoryPath, ["show", "--format=", "--binary", archiveId]);
      return { archiveId, patchDigest: patchDigest(archive.stdout) };
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
      const statusResult = await git(repositoryPath, ["status", "--porcelain=v1"]);
      await assertOwnership();
      const treeResult = await gitAllowFailure(repositoryPath, ["diff", "--quiet", recoveryPoint.snapshot.head, "HEAD"]);
      await assertOwnership();
      const observedHead = output(headResult);
      const observedBranch = output(branchResult);
      const observedStatus = output(statusResult);
      const passed = treeResult.exitCode === 0
        && observedBranch === recoveryPoint.snapshot.branch
        && observedStatus === recoveryPoint.snapshot.status;
      return {
        passed,
        observedOutput: `HEAD=${observedHead}; branch=${observedBranch}; status=${observedStatus || "clean"}`,
        reason: passed ? "Recovery tree, branch, and workspace verified" : `Recovery point mismatch: expected tree=${recoveryPoint.snapshot.head}, branch=${recoveryPoint.snapshot.branch}, status=${recoveryPoint.snapshot.status || "clean"}; observed HEAD=${observedHead}, branch=${observedBranch}, status=${observedStatus || "clean"}`,
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
    const point = capturedPoint(state);
    if (point.snapshot.workspacePath !== repositoryPath) throw new Error("Recovery workspace does not match the configured repository");
    await assertOwnership();
    const currentHead = output(await git(repositoryPath, ["rev-parse", "HEAD"]));
    await assertOwnership();
    const commitsToRevert = currentHead === point.snapshot.head
      ? []
      : output(await git(repositoryPath, ["rev-list", `${point.snapshot.head}..${currentHead}`])).split(/\r?\n/).filter((commit) => commit.length > 0);
    return safeRollback({ recoveryPoint: point, commitsToRevert, adapter: createAdapter(repositoryPath, assertOwnership) });
  };
}
