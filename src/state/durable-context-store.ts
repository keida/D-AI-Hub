import type { CloseCandidate, DurableContextManifest, Environment, TaskState } from "../domain/types.js";

export interface TaskOwnershipLease {
  readonly taskId: string;
  readonly environment: Environment;
  readonly generation: bigint;
  readonly ownerToken: string;
}

export type TaskOwnershipGuard = () => Promise<void>;

declare const taskOwnershipTransitionCapability: unique symbol;

export interface TaskOwnershipTransition {
  readonly lease: TaskOwnershipLease;
  readonly targetEnvironment: Environment;
  readonly [taskOwnershipTransitionCapability]: true;
}

export type TaskStateWriteAuthorization = TaskOwnershipLease | TaskOwnershipTransition;
export type TaskOwnershipTransitionAuthorizer = (targetEnvironment: Environment) => TaskStateWriteAuthorization;
export type TaskOwnershipTransfer = (targetEnvironment: Environment) => Promise<TaskOwnershipLease>;

export interface DurableContextStore {
  load(taskId: string): Promise<TaskState | null>;
  loadGenerationManifest?(taskId: string, manifestId: string): Promise<DurableContextManifest>;
  verifyDurableSnapshot?(manifest: DurableContextManifest): Promise<void>;
  save(state: TaskState, authorization?: TaskStateWriteAuthorization): Promise<DurableContextManifest>;
  saveCloseCandidate?(candidate: CloseCandidate, lease?: TaskOwnershipLease): Promise<void>;
  loadCloseCandidate?(taskId: string): Promise<CloseCandidate | null>;
  recordCriticalUnsavedContext(taskId: string, items: readonly string[], lease?: TaskOwnershipLease): Promise<void>;
  clearCriticalUnsavedContext(taskId: string, lease?: TaskOwnershipLease): Promise<void>;
  withTaskOwnership?<T>(
    taskId: string,
    environment: Environment,
    operation: (
      lease: TaskOwnershipLease,
      transfer: TaskOwnershipTransfer,
      assertOwnership: TaskOwnershipGuard,
      authorizeTransition: TaskOwnershipTransitionAuthorizer,
    ) => Promise<T>,
  ): Promise<T>;
}
