import type { CloseCandidate, DurableContextManifest, Environment, TaskState } from "../domain/types.js";

export interface TaskOwnershipLease {
  readonly taskId: string;
  readonly environment: Environment;
  readonly generation: bigint;
  readonly ownerToken: string;
}

export interface DurableContextStore {
  load(taskId: string): Promise<TaskState | null>;
  loadGenerationManifest?(taskId: string, manifestId: string): Promise<DurableContextManifest>;
  save(state: TaskState, lease?: TaskOwnershipLease): Promise<DurableContextManifest>;
  saveCloseCandidate?(candidate: CloseCandidate): Promise<void>;
  loadCloseCandidate?(taskId: string): Promise<CloseCandidate | null>;
  recordCriticalUnsavedContext(taskId: string, items: readonly string[]): Promise<void>;
  clearCriticalUnsavedContext(taskId: string): Promise<void>;
  withTaskOwnership?<T>(
    taskId: string,
    environment: Environment,
    operation: (lease: TaskOwnershipLease, transfer: (targetEnvironment: Environment) => Promise<void>) => Promise<T>,
  ): Promise<T>;
}
