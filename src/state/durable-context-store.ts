import type { DurableContextManifest, TaskState } from "../domain/types.js";

export interface DurableContextStore {
  load(taskId: string): Promise<TaskState | null>;
  save(state: TaskState): Promise<DurableContextManifest>;
  recordCriticalUnsavedContext(taskId: string, items: readonly string[]): Promise<void>;
  clearCriticalUnsavedContext(taskId: string): Promise<void>;
}
