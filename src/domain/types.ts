export type Environment = "chat" | "work" | "codex";

export type Stage =
  | "bootstrap"
  | "route"
  | "plan"
  | "execute"
  | "inspect"
  | "verify"
  | "debug"
  | "recover"
  | "handoff"
  | "close";

export type Role =
  | "analyst"
  | "planner"
  | "implementer"
  | "evidence-collector"
  | "reviewer"
  | "debugger"
  | "recovery-operator";

export type DebugPhase =
  | "reproduce"
  | "capture"
  | "isolate"
  | "hypothesize"
  | "change"
  | "reverify"
  | "regress"
  | "stop";

export interface DebugSession {
  readonly phase: DebugPhase;
  readonly originalFailure: string;
  readonly hypothesis: string | null;
  readonly preservedRecoveryPointId: string;
}

export interface RoutingDecision {
  readonly stage: Stage;
  readonly requestedStage?: Stage | undefined;
  readonly environment: Environment;
  readonly role: Role;
  readonly selectedModel: string;
  readonly selectedCapabilities: readonly string[];
  readonly reason: string;
  readonly overrideSource: "default" | "user";
}

export interface VerificationEvidence {
  readonly evidenceId: string;
  readonly stage: Stage;
  readonly environment: Environment;
  readonly role: Role;
  readonly selectedModel: string;
  readonly command: string;
  readonly observedOutput: string;
  readonly exitCode: number | null;
  readonly interpretation: string;
  readonly passed: boolean;
  readonly recoveryPointId: string | null;
  readonly recordedAt: string;
}

export interface DurableContextManifest {
  readonly manifestId: string;
  readonly taskId: string;
  readonly stage: Stage;
  readonly environment: Environment;
  readonly role: Role;
  readonly durablePaths: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly recoveryPointId: string | null;
  readonly recordedAt: string;
}

export interface RecoveryPoint {
  readonly recoveryPointId: string;
  readonly taskId: string;
  readonly stage: Stage;
  readonly environment: Environment;
  readonly role: Role;
  readonly durablePaths: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly restorationInstructions: string;
  readonly createdAt: string;
  readonly snapshotManifestId?: string | undefined;
}

export interface RecoverySnapshot {
  readonly head: string;
  readonly branch: string;
  readonly workspacePath: string;
  readonly status: string;
  readonly binaryPatch: string;
  readonly stateManifest: DurableContextManifest;
  readonly verificationResults: readonly VerificationEvidence[];
  readonly durableArtifacts: Readonly<Record<string, string>>;
}

export interface RollbackAuditAction {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export interface RollbackAudit {
  readonly archiveId: string;
  readonly patchDigest: string;
  readonly actions: readonly RollbackAuditAction[];
  readonly verification: {
    readonly passed: boolean;
    readonly observedOutput: string;
    readonly reason: string;
  };
  readonly recordedAt: string;
}

export interface CloseCandidate {
  readonly taskId: string;
  readonly durableContext: DurableContextManifest;
  readonly contextManifest: readonly string[];
  readonly repositoryPath: string;
  readonly remote: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly criticalUnsavedContext: readonly string[];
  readonly recordedAt: string;
}

export interface CloseVerdict {
  readonly taskId: string;
  readonly status: "YES" | "NO" | "BLOCKED";
  readonly stage: Stage;
  readonly environment: Environment;
  readonly role: Role;
  readonly selectedModel: string;
  readonly evidence: readonly VerificationEvidence[];
  readonly recoveryPoint: RecoveryPoint | null;
  readonly durablePaths: readonly string[];
  readonly hashes: Readonly<Record<string, string>>;
  readonly closeCandidate: CloseCandidate | null;
  readonly reasons: readonly string[];
}

export interface TaskState {
  readonly taskId: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly environment: Environment;
  readonly stage: Stage;
  readonly role: Role;
  readonly routingDecision: RoutingDecision | null;
  readonly selectedCapabilities: readonly string[];
  readonly contextManifest: readonly string[];
  readonly handoffState: "none" | "pending" | "acknowledged" | "active" | "completed" | "rejected";
  readonly verificationEvidence: readonly VerificationEvidence[];
  readonly verificationHistory?: readonly VerificationEvidence[] | undefined;
  readonly recoveryPoint: RecoveryPoint | null;
  readonly recoverySnapshot?: RecoverySnapshot | null | undefined;
  readonly rollbackAudit?: RollbackAudit | null | undefined;
  readonly approvalState: "not-required" | "pending" | "approved" | "rejected";
  readonly criticalUnsavedContext: readonly string[];
  readonly durableContext: DurableContextManifest | null;
  readonly closeCandidate?: CloseCandidate | null | undefined;
  readonly debugSession?: DebugSession | null | undefined;
}
