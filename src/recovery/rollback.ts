import { redactSensitiveText } from "../adapters/command-runner.js";
import { InvalidTaskStateError, UnsavedContextError, VerificationGateError } from "../domain/errors.js";
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

export async function safeRollback(input: RollbackInput): Promise<RollbackResult> {
  const preservedUserWork = await input.adapter.preserveUncommittedWork();
  assertPreservedUserWork(preservedUserWork);
  const actions: AuditableGitAction[] = [];
  for (const commit of input.commitsToRevert) {
    assertCommit(commit);
    actions.push(assertAuditableAction(await input.adapter.revertCommit(commit), "revert"));
  }
  actions.push(assertAuditableAction(await input.adapter.restoreRecoveryPatch(input.recoveryPoint.snapshot.binaryPatch), "apply"));
  const verification = await input.adapter.verifyRecoveryPoint(input.recoveryPoint);
  if (!verification.passed) throw new VerificationGateError(`Recovery point verification failed: ${redactSensitiveText(verification.reason)}`);
  return {
    preservedUserWork,
    actions,
    verification: {
      passed: true,
      observedOutput: redactSensitiveText(verification.observedOutput),
      reason: redactSensitiveText(verification.reason),
    },
  };
}
