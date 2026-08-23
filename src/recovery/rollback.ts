import { CommandExecutionError, redactSensitiveText } from "../adapters/command-runner.js";
import { InvalidTaskStateError, TaskOwnershipError, UnsavedContextError, VerificationGateError } from "../domain/errors.js";
import type { CapturedRecoveryPoint } from "./recovery-point-service.js";

export interface PreservedUserWork {
  readonly archiveId: string;
  readonly patchDigest: string;
}

export interface AuditableGitAction {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface RollbackVerification {
  readonly passed: boolean;
  readonly observedOutput: string;
  readonly reason: string;
}

export interface RollbackAdapter {
  preserveUncommittedWork(): Promise<PreservedUserWork>;
  revertCommit(commit: string): Promise<AuditableGitAction>;
  restoreRecoveryPatch(binaryPatch: string): Promise<AuditableGitAction>;
  verifyRecoveryPoint(recoveryPoint: CapturedRecoveryPoint): Promise<RollbackVerification>;
}

export interface RollbackInput {
  readonly recoveryPoint: CapturedRecoveryPoint;
  readonly commitsToRevert: readonly string[];
  readonly adapter: RollbackAdapter;
}

export interface RollbackResult {
  readonly preservedUserWork: PreservedUserWork;
  readonly actions: readonly AuditableGitAction[];
  readonly verification: RollbackVerification;
}

export class RollbackPartialFailureError extends Error {
  public readonly result: RollbackResult;

  public constructor(result: RollbackResult, message: string) {
    super(message);
    this.name = "RollbackPartialFailureError";
    this.result = result;
  }
}

function assertCommit(commit: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new InvalidTaskStateError("Rollback commit must be a full Git object id");
}

function assertPreservedUserWork(work: PreservedUserWork): void {
  if (work.archiveId.trim().length === 0 || !/^[a-f0-9]{64}$/i.test(work.patchDigest)) {
    throw new UnsavedContextError("Uncommitted user work was not preserved as an auditable patch archive");
  }
}

function sanitizedAction(action: AuditableGitAction): AuditableGitAction {
  return {
    command: redactSensitiveText(action.command),
    arguments: action.arguments.map(redactSensitiveText),
    stdout: redactSensitiveText(action.stdout),
    stderr: redactSensitiveText(action.stderr),
    exitCode: action.exitCode,
  };
}

function assertAuditableAction(action: AuditableGitAction, operation: "revert" | "apply"): AuditableGitAction {
  const sanitized = sanitizedAction(action);
  if (sanitized.command !== "git" || sanitized.arguments[0] !== operation || sanitized.exitCode !== 0) {
    throw new VerificationGateError(`Rollback ${operation} action was not an auditable successful git ${operation}`);
  }
  if (sanitized.arguments.includes("reset") || sanitized.arguments.includes("clean")) {
    throw new VerificationGateError("Rollback action attempted a destructive Git operation");
  }
  return sanitized;
}

function failedCommandAction(error: unknown): AuditableGitAction | null {
  if (!(error instanceof CommandExecutionError)) return null;
  return sanitizedAction(error.result);
}

function incompletePreservedUserWork(): PreservedUserWork {
  return { archiveId: "preserve-failed", patchDigest: "0".repeat(64) };
}

function ownershipPartialFailure(
  preservedUserWork: PreservedUserWork,
  actions: readonly AuditableGitAction[],
  error: TaskOwnershipError,
): RollbackPartialFailureError {
  const message = redactSensitiveText(error.message);
  return new RollbackPartialFailureError(
    {
      preservedUserWork,
      actions,
      verification: { passed: false, observedOutput: "", reason: `Rollback ownership was lost after Git mutation: ${message}` },
    },
    message,
  );
}

export async function safeRollback(input: RollbackInput): Promise<RollbackResult> {
  let preservedUserWork: PreservedUserWork;
  try {
    preservedUserWork = await input.adapter.preserveUncommittedWork();
  } catch (error: unknown) {
    if (error instanceof TaskOwnershipError || error instanceof RollbackPartialFailureError) throw error;
    const failedAction = failedCommandAction(error);
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    throw new RollbackPartialFailureError(
      {
        preservedUserWork: incompletePreservedUserWork(),
        actions: failedAction === null ? [] : [failedAction],
        verification: { passed: false, observedOutput: "", reason: `Preserve stage failed: ${message}` },
      },
      `Preserve stage failed: ${message}`,
    );
  }
  assertPreservedUserWork(preservedUserWork);
  const actions: AuditableGitAction[] = [];
  for (const commit of input.commitsToRevert) {
    try {
      assertCommit(commit);
      actions.push(assertAuditableAction(await input.adapter.revertCommit(commit), "revert"));
    } catch (error: unknown) {
      if (error instanceof TaskOwnershipError) {
        if (actions.length === 0) throw error;
        throw ownershipPartialFailure(preservedUserWork, actions, error);
      }
      const failedAction = failedCommandAction(error);
      throw new RollbackPartialFailureError(
        {
          preservedUserWork,
          actions: failedAction === null ? actions : [...actions, failedAction],
          verification: { passed: false, observedOutput: "", reason: redactSensitiveText(error instanceof Error ? error.message : String(error)) },
        },
        redactSensitiveText(error instanceof Error ? error.message : String(error)),
      );
    }
  }
  try {
    actions.push(assertAuditableAction(await input.adapter.restoreRecoveryPatch(input.recoveryPoint.snapshot.binaryPatch), "apply"));
  } catch (error: unknown) {
    if (error instanceof TaskOwnershipError) {
      if (actions.length === 0) throw error;
      throw ownershipPartialFailure(preservedUserWork, actions, error);
    }
    const failedAction = failedCommandAction(error);
    throw new RollbackPartialFailureError(
      {
        preservedUserWork,
        actions: failedAction === null ? actions : [...actions, failedAction],
        verification: { passed: false, observedOutput: "", reason: redactSensitiveText(error instanceof Error ? error.message : String(error)) },
      },
      redactSensitiveText(error instanceof Error ? error.message : String(error)),
    );
  }
  let verification: RollbackVerification;
  try {
    verification = await input.adapter.verifyRecoveryPoint(input.recoveryPoint);
  } catch (error: unknown) {
    if (error instanceof TaskOwnershipError) {
      if (actions.length === 0) throw error;
      throw ownershipPartialFailure(preservedUserWork, actions, error);
    }
    throw new RollbackPartialFailureError(
      {
        preservedUserWork,
        actions,
        verification: { passed: false, observedOutput: "", reason: redactSensitiveText(error instanceof Error ? error.message : String(error)) },
      },
      redactSensitiveText(error instanceof Error ? error.message : String(error)),
    );
  }
  return {
    preservedUserWork,
    actions,
    verification: {
      passed: verification.passed,
      observedOutput: redactSensitiveText(verification.observedOutput),
      reason: redactSensitiveText(verification.reason),
    },
  };
}
