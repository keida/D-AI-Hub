export type MemoryStoreMode = "reader" | "writer";

export type MemoryValue = null | boolean | number | string | readonly MemoryValue[] | { readonly [key: string]: MemoryValue };

export interface MemoryRecord {
  readonly memoryId: string;
  readonly scopeId: string;
  readonly writerId: string;
  readonly sequence: number;
  readonly value: MemoryValue;
  readonly valueSha256: string;
  readonly recordedAt: string;
}

export interface LocalSqliteMemoryStoreOptions {
  readonly databasePath: string;
  readonly workspacePath: string;
  readonly mode: MemoryStoreMode;
  readonly scopeId: string;
  readonly writerId: string;
}

export interface PutMemoryInput {
  readonly memoryId: string;
  readonly value: MemoryValue;
  readonly recordedAt: string;
}
