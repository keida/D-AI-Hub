import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, linkSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { TextDecoder } from "node:util";
import { InvalidTaskStateError } from "../domain/errors.js";
import { containsSecretShapedValue } from "../domain/manifest-id.js";
import type { LocalSqliteMemoryStoreOptions, MemoryRecord, MemoryStoreMode, MemoryValue, PutMemoryInput } from "./types.js";

interface MemoryRow {
  readonly memory_id: string;
  readonly scope_id: string;
  readonly writer_id: string;
  readonly sequence: number;
  readonly value_json: string;
  readonly value_sha256: string;
  readonly recorded_at: string;
}

export interface AppliedMemoryBundleReceipt {
  readonly bundleId: string;
  readonly recordsSha256: string;
  readonly appliedAt: string;
}

export interface ImportedMemoryBundleInput {
  readonly bundleId: string;
  readonly recordsSha256: string;
  readonly records: readonly MemoryRecord[];
  readonly recordsBytes: Uint8Array;
  readonly appliedAt: string;
}

export type AppliedMemoryBundleOutcome = "IMPORTED" | "NOOP_DUPLICATE" | "BLOCKED";

export interface AppliedMemoryBundleResult extends AppliedMemoryBundleReceipt {
  readonly outcome: AppliedMemoryBundleOutcome;
  readonly importedCount: number;
  readonly reason?: string;
}

const memorySchema = `
  CREATE TABLE IF NOT EXISTS memory_records (
    scope_id TEXT NOT NULL,
    memory_id TEXT NOT NULL,
    writer_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    value_json TEXT NOT NULL,
    value_sha256 TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, memory_id),
    UNIQUE (scope_id, writer_id, sequence)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS applied_bundles (
    scope_id TEXT NOT NULL,
    bundle_id TEXT NOT NULL,
    records_sha256 TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (scope_id, bundle_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS memory_scopes (
    scope_id TEXT PRIMARY KEY,
    writer_id TEXT NOT NULL,
    workspace_path TEXT NOT NULL
  ) STRICT;
`;

type RemoveArtifact = (path: string) => void;

export function cleanupReaderInitializationArtifacts<T>(temporaryPath: string, originalError: T, removeArtifact: RemoveArtifact = (path) => rmSync(path, { force: true, recursive: true })): T {
  for (const path of [temporaryPath, `${temporaryPath}-journal`, `${temporaryPath}-wal`, `${temporaryPath}-shm`]) {
    try {
      removeArtifact(path);
    } catch {
      // Cleanup is best effort; never mask the initialization error or skip another path.
    }
  }
  return originalError;
}

function assertMemorySchema(database: DatabaseSync): void {
  const expected: Record<string, Array<{ readonly name: string; readonly type: string; readonly notnull: number; readonly pk: number }>> = {
    memory_records: [
      { name: "scope_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "memory_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "writer_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "sequence", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "value_json", type: "TEXT", notnull: 1, pk: 0 },
      { name: "value_sha256", type: "TEXT", notnull: 1, pk: 0 },
      { name: "recorded_at", type: "TEXT", notnull: 1, pk: 0 },
    ],
    applied_bundles: [
      { name: "scope_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "bundle_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "records_sha256", type: "TEXT", notnull: 1, pk: 0 },
      { name: "applied_at", type: "TEXT", notnull: 1, pk: 0 },
    ],
    memory_scopes: [
      { name: "scope_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "writer_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "workspace_path", type: "TEXT", notnull: 1, pk: 0 },
    ],
  };
  const tables = database.prepare("PRAGMA table_list").all() as Array<{ readonly schema: string; readonly name: string; readonly type: string; readonly strict: number }>;
  for (const [tableName, columns] of Object.entries(expected)) {
    const table = tables.find((candidate) => candidate.schema === "main" && candidate.name === tableName);
    if (table?.type !== "table" || table.strict !== 1) throw new InvalidTaskStateError("Memory database schema is not initialized or STRICT");
    const observed = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ readonly name: string; readonly type: string; readonly notnull: number; readonly pk: number }>;
    if (observed.length !== columns.length || observed.some((column, index) => {
      const expectedColumn = columns[index]!;
      return column.name !== expectedColumn.name || column.type !== expectedColumn.type || column.notnull !== expectedColumn.notnull || column.pk !== expectedColumn.pk;
    })) throw new InvalidTaskStateError("Memory database schema columns are invalid");
  }
  const uniqueIndexes = database.prepare("PRAGMA index_list(memory_records)").all() as Array<{ readonly name: string; readonly unique: number }>;
  const uniqueRecordIndex = uniqueIndexes.find((index) => index.unique === 1 && database.prepare(`PRAGMA index_info(\"${index.name.replaceAll('"', '""')}\")`).all().map((column) => (column as { readonly name: string }).name).join(",") === "scope_id,writer_id,sequence");
  if (uniqueRecordIndex === undefined) throw new InvalidTaskStateError("Memory database sequence constraint is invalid");
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized !== value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) {
    throw new InvalidTaskStateError(`${label} must use 1-128 safe identifier characters`);
  }
  if (containsSecretShapedValue(normalized)) {
    throw new InvalidTaskStateError(`${label} must not contain secret-shaped content`);
  }
  return normalized;
}

function assertStoreMode(value: unknown): asserts value is MemoryStoreMode {
  if (value !== "reader" && value !== "writer") {
    throw new InvalidTaskStateError("Memory store mode must be reader or writer");
  }
}

function canonicalizeWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new InvalidTaskStateError("Memory workspacePath is required");
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(value));
  } catch {
    throw new InvalidTaskStateError("Memory workspacePath must resolve to an existing local workspace");
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function assertRecordedAt(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new InvalidTaskStateError("Memory recordedAt must be an ISO timestamp");
  }
  return value;
}

function assertSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new InvalidTaskStateError(`${label} must be a SHA-256 hex digest`);
  return value;
}

function isMemoryValue(value: unknown): value is MemoryValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isMemoryValue);
  if (typeof value !== "object" || !isPlainObject(value)) return false;
  return Object.values(value).every(isMemoryValue);
}

function snapshotMemoryValue(value: unknown): MemoryValue {
  const active = new WeakSet<object>();

  const snapshot = (candidate: unknown): MemoryValue => {
    if (candidate === null || typeof candidate === "boolean" || typeof candidate === "string") return candidate;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new InvalidTaskStateError("Memory value must be JSON data without undefined or non-finite numbers");
      return candidate;
    }
    if (typeof candidate !== "object") throw new InvalidTaskStateError("Memory value must be JSON data without symbols or undefined");
    if (active.has(candidate)) throw new InvalidTaskStateError("Memory value must not contain cycles");
    active.add(candidate);
    try {
      let prototype: object | null;
      let keys: readonly (string | symbol)[];
      try {
        prototype = Object.getPrototypeOf(candidate);
        keys = Reflect.ownKeys(candidate);
      } catch {
        throw new InvalidTaskStateError("Memory value snapshot failed for an inconsistent object");
      }

      if (Array.isArray(candidate)) {
        if (prototype !== Array.prototype) throw new InvalidTaskStateError("Memory value must be a plain JSON array");
        const lengthDescriptor = Object.getOwnPropertyDescriptor(candidate, "length");
        if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
          throw new InvalidTaskStateError("Memory value array length is invalid");
        }
        const length = lengthDescriptor.value;
        const values: MemoryValue[] = [];
        const expectedKeys = new Set<string>(["length"]);
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          expectedKeys.add(key);
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
            throw new InvalidTaskStateError("Memory value arrays must not be sparse or accessor-backed");
          }
          values.push(snapshot(descriptor.value));
        }
        for (const key of keys) {
          if (typeof key === "symbol" || !expectedKeys.has(key)) {
            throw new InvalidTaskStateError("Memory value arrays must not contain symbols or extra properties");
          }
        }
        return values;
      }

      if (prototype !== Object.prototype && prototype !== null) {
        throw new InvalidTaskStateError("Memory value must be JSON data in a plain JSON object");
      }
      const result: Record<string, MemoryValue> = Object.create(prototype) as Record<string, MemoryValue>;
      for (const key of keys) {
        if (typeof key === "symbol") throw new InvalidTaskStateError("Memory value objects must not contain symbols");
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new InvalidTaskStateError("Memory value objects must not contain accessors or hidden properties");
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: snapshot(descriptor.value),
          writable: true,
        });
      }
      return result;
    } finally {
      active.delete(candidate);
    }
  };

  try {
    return snapshot(value);
  } catch (error) {
    if (error instanceof InvalidTaskStateError) throw error;
    throw new InvalidTaskStateError("Memory value snapshot failed");
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMemoryArray(value: MemoryValue): value is readonly MemoryValue[] {
  return Array.isArray(value);
}

function canonicalJson(value: MemoryValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (isMemoryArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function canonicalRecordJson(record: MemoryRecord): string {
  const fields: Record<string, MemoryValue> = {
    memoryId: record.memoryId,
    recordedAt: record.recordedAt,
    scopeId: record.scopeId,
    sequence: record.sequence,
    value: record.value,
    valueSha256: record.valueSha256,
    writerId: record.writerId,
  };
  return `{${Object.keys(fields).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(fields[key]!)}`).join(",")}}`;
}

function decodeExactUtf8(bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidTaskStateError("Memory bundle JSONL must be valid UTF-8");
  }
  if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) {
    throw new InvalidTaskStateError("Memory bundle JSONL bytes are not exact UTF-8");
  }
  return decoded;
}

function assertNoSecretShapedValue(value: MemoryValue): void {
  if (typeof value === "string") {
    if (containsSecretShapedValue(value)) {
      throw new InvalidTaskStateError("Secret-shaped memory input is not permitted");
    }
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return;
  if (isMemoryArray(value)) {
    value.forEach(assertNoSecretShapedValue);
    return;
  }
  Object.keys(value).forEach((key) => {
    if (containsSecretShapedValue(key)) {
      throw new InvalidTaskStateError("Secret-shaped memory input is not permitted");
    }
  });
  Object.values(value).forEach(assertNoSecretShapedValue);
}

function assertImportedBundleInput(input: ImportedMemoryBundleInput, scopeId: string, writerId: string): void {
  assertIdentifier(input.bundleId, "Memory bundleId");
  assertSha256(input.recordsSha256, "Memory recordsSha256");
  assertRecordedAt(input.appliedAt);
  if (!(input.recordsBytes instanceof Uint8Array)) {
    throw new InvalidTaskStateError("Memory bundle JSONL bytes are required");
  }
  const recordsJsonl = decodeExactUtf8(input.recordsBytes);
  if (containsSecretShapedValue(recordsJsonl)) {
    throw new InvalidTaskStateError("Secret-shaped or invalid memory bundle JSONL is not permitted");
  }
  const records = input.records;
  if (!Array.isArray(records)) throw new InvalidTaskStateError("Memory bundle records must be an array");
  const ids = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] as unknown;
    if (typeof record !== "object" || record === null || !isPlainObject(record)) throw new InvalidTaskStateError("Memory bundle record must be an object");
    const required = ["memoryId", "scopeId", "writerId", "sequence", "value", "valueSha256", "recordedAt"];
    if (Object.keys(record).some((key) => !required.includes(key)) || required.some((key) => !(key in record))) {
      throw new InvalidTaskStateError("Memory bundle record schema is invalid");
    }
    const candidate = record as unknown as MemoryRecord;
    const memoryId = assertIdentifier(candidate.memoryId, "Memory memoryId");
    if (ids.has(memoryId)) throw new InvalidTaskStateError(`Memory bundle contains duplicate ID ${memoryId}`);
    ids.add(memoryId);
    if (candidate.scopeId !== scopeId || candidate.writerId !== writerId) throw new InvalidTaskStateError("Memory bundle record identity does not match the configured store");
    if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence < 1 || (index > 0 && candidate.sequence !== records[index - 1]!.sequence + 1)) {
      throw new InvalidTaskStateError("Memory bundle records must use a positive contiguous sequence");
    }
    if (!isMemoryValue(candidate.value)) throw new InvalidTaskStateError("Memory bundle value is not JSON data");
    assertSha256(candidate.valueSha256, "Memory valueSha256");
    if (createHash("sha256").update(canonicalJson(candidate.value), "utf8").digest("hex") !== candidate.valueSha256) {
      throw new InvalidTaskStateError(`Memory value hash mismatch for ${memoryId}`);
    }
    assertNoSecretShapedValue(candidate.value);
    assertRecordedAt(candidate.recordedAt);
  }
  const canonicalRecordsJsonl = records.map(canonicalRecordJson).join("\n") + (records.length > 0 ? "\n" : "");
  const canonicalBytes = Buffer.from(canonicalRecordsJsonl, "utf8");
  if (!canonicalBytes.equals(Buffer.from(input.recordsBytes))) throw new InvalidTaskStateError("Memory bundle JSONL is not canonical");
  if (createHash("sha256").update(input.recordsBytes).digest("hex") !== input.recordsSha256) throw new InvalidTaskStateError("Memory bundle records digest does not match its content");
}

function snapshotImportedBundleInput(input: ImportedMemoryBundleInput): ImportedMemoryBundleInput {
  try {
    const recordsBytes = input.recordsBytes;
    if (!(recordsBytes instanceof Uint8Array)) {
      throw new InvalidTaskStateError("Memory bundle JSONL bytes are required");
    }
    return {
      bundleId: input.bundleId,
      recordsSha256: input.recordsSha256,
      records: snapshotMemoryValue(input.records) as unknown as readonly MemoryRecord[],
      recordsBytes: new Uint8Array(recordsBytes),
      appliedAt: input.appliedAt,
    };
  } catch (error) {
    if (error instanceof InvalidTaskStateError) throw error;
    throw new InvalidTaskStateError("Memory bundle snapshot failed");
  }
}

function toRecord(row: MemoryRow): MemoryRecord {
  assertIdentifier(row.memory_id, "Stored memoryId");
  assertIdentifier(row.scope_id, "Stored scopeId");
  assertIdentifier(row.writer_id, "Stored writerId");
  const value = JSON.parse(row.value_json) as unknown;
  if (!isMemoryValue(value)) {
    throw new InvalidTaskStateError(`Stored memory ${row.memory_id} is not valid JSON data`);
  }
  const observedHash = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
  if (observedHash !== row.value_sha256) {
    throw new InvalidTaskStateError(`Memory integrity check failed for ${row.memory_id}`);
  }
  assertNoSecretShapedValue(value);
  return {
    memoryId: row.memory_id,
    scopeId: row.scope_id,
    writerId: row.writer_id,
    sequence: row.sequence,
    value,
    valueSha256: row.value_sha256,
    recordedAt: row.recorded_at,
  };
}

export class LocalSqliteMemoryStore {
  private readonly database: DatabaseSync;
  private readonly options: LocalSqliteMemoryStoreOptions;

  public constructor(options: LocalSqliteMemoryStoreOptions) {
    assertStoreMode(options.mode);
    if (typeof options.databasePath !== "string" || options.databasePath.trim().length === 0) {
      throw new InvalidTaskStateError("Memory databasePath is required");
    }
    this.options = {
      ...options,
      workspacePath: canonicalizeWorkspacePath(options.workspacePath),
      scopeId: assertIdentifier(options.scopeId, "Memory scopeId"),
      writerId: assertIdentifier(options.writerId, "Memory writerId"),
    };
    if (options.mode === "writer" && !existsSync(options.databasePath)) {
      LocalSqliteMemoryStore.initializeMissingDatabase(this.options);
    }
    this.database = new DatabaseSync(options.databasePath, { readOnly: options.mode === "reader" });
    try {
      if (options.mode === "writer") {
        this.initializeWriterDatabase();
      } else {
        this.assertRequiredSchema();
        this.assertScopeBinding(false);
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  public static initializeReaderDatabase(options: LocalSqliteMemoryStoreOptions): void {
    assertStoreMode(options.mode);
    if (options.mode !== "reader") throw new InvalidTaskStateError("Reader database initialization requires reader mode");
    if (options.databasePath.trim().length === 0) throw new InvalidTaskStateError("Memory databasePath is required");
    const normalizedOptions: LocalSqliteMemoryStoreOptions = {
      ...options,
      workspacePath: canonicalizeWorkspacePath(options.workspacePath),
      scopeId: assertIdentifier(options.scopeId, "Memory scopeId"),
      writerId: assertIdentifier(options.writerId, "Memory writerId"),
    };
    if (existsSync(options.databasePath)) {
      const database = new DatabaseSync(options.databasePath, { readOnly: true });
      try {
        assertMemorySchema(database);
        LocalSqliteMemoryStore.assertScopeBindingOnDatabase(database, normalizedOptions, false);
      } finally {
        database.close();
      }
      return;
    }

    LocalSqliteMemoryStore.initializeMissingDatabase(normalizedOptions);
  }

  private static initializeMissingDatabase(options: LocalSqliteMemoryStoreOptions): void {
    const temporaryPath = `${options.databasePath}.tmp-${randomUUID()}`;
    let database: DatabaseSync | undefined;
    let transactionStarted = false;
    try {
      database = new DatabaseSync(temporaryPath);
      database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      database.exec(memorySchema);
      assertMemorySchema(database);
      LocalSqliteMemoryStore.assertScopeBindingOnDatabase(database, options, true);
      database.exec("COMMIT");
      transactionStarted = false;
      database.close();
      database = undefined;
      if (existsSync(options.databasePath)) throw new InvalidTaskStateError("Reader database appeared during initialization");
      linkSync(temporaryPath, options.databasePath);
      rmSync(temporaryPath, { force: true });
    } catch (error) {
      if (transactionStarted && database !== undefined) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The connection may already have failed; cleanup below is still exact.
        }
      }
      if (database !== undefined) {
        try {
          database.close();
        } catch {
          // Cleanup must continue even when closing the failed connection errors.
        }
      }
      cleanupReaderInitializationArtifacts(temporaryPath, error);
      throw error;
    }
  }

  private initializeWriterDatabase(): void {
    let transactionStarted = false;
    try {
      this.database.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      this.database.exec(memorySchema);
      assertMemorySchema(this.database);
      this.assertScopeBinding(true);
      this.database.exec("COMMIT");
    } catch (error) {
      if (transactionStarted) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the initialization failure; constructor cleanup closes the connection.
        }
      }
      throw error;
    }
  }

  private assertRequiredSchema(): void {
    assertMemorySchema(this.database);
  }

  private static assertScopeBindingOnDatabase(database: DatabaseSync, options: LocalSqliteMemoryStoreOptions, registerBinding: boolean): void {
    const configured = options.writerId;
    const rows = database.prepare("SELECT DISTINCT writer_id FROM memory_records WHERE scope_id = ?").all(options.scopeId) as unknown as Array<{ readonly writer_id: string }>;
    const observed = new Set(rows.map((row) => row.writer_id));
    if (observed.size > 1 || (observed.size === 1 && !observed.has(configured))) {
      throw new InvalidTaskStateError(`Memory scope ${options.scopeId} has a conflicting writer identity`);
    }
    const scope = database.prepare("SELECT writer_id, workspace_path FROM memory_scopes WHERE scope_id = ?").get(options.scopeId) as { readonly writer_id: string; readonly workspace_path: string } | undefined;
    if (scope !== undefined && scope.writer_id !== configured) {
      throw new InvalidTaskStateError(`Memory scope ${options.scopeId} is owned by writer ${scope.writer_id}`);
    }
    if (scope !== undefined && scope.workspace_path !== options.workspacePath) {
      throw new InvalidTaskStateError(`Memory scope ${options.scopeId} is bound to a different workspace`);
    }
    if (registerBinding && scope === undefined) {
      database.prepare("INSERT INTO memory_scopes (scope_id, writer_id, workspace_path) VALUES (?, ?, ?)")
        .run(options.scopeId, configured, options.workspacePath);
    }
  }

  private assertScopeBinding(registerBinding: boolean): void {
    LocalSqliteMemoryStore.assertScopeBindingOnDatabase(this.database, this.options, registerBinding);
  }

  public get scopeId(): string {
    return this.options.scopeId;
  }

  public get writerId(): string {
    return this.options.writerId;
  }

  public get mode(): MemoryStoreMode {
    return this.options.mode;
  }

  public async listAfter(sequence: number): Promise<MemoryRecord[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new InvalidTaskStateError("Memory sequence must be a non-negative integer");
    }
    const rows = this.database
      .prepare("SELECT memory_id, scope_id, writer_id, sequence, value_json, value_sha256, recorded_at FROM memory_records WHERE scope_id = ? AND writer_id = ? AND sequence > ? ORDER BY sequence ASC")
      .all(this.options.scopeId, this.options.writerId, sequence) as unknown as MemoryRow[];
    return rows.map(toRecord);
  }

  public getAppliedBundleReceipt(bundleId: string): AppliedMemoryBundleReceipt | null {
    const normalizedBundleId = assertIdentifier(bundleId, "Memory bundleId");
    let row: { readonly bundle_id: string; readonly records_sha256: string; readonly applied_at: string } | undefined;
    try {
      row = this.database
        .prepare("SELECT bundle_id, records_sha256, applied_at FROM applied_bundles WHERE scope_id = ? AND bundle_id = ?")
        .get(this.options.scopeId, normalizedBundleId) as { readonly bundle_id: string; readonly records_sha256: string; readonly applied_at: string } | undefined;
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
      return null;
    }
    return row === undefined ? null : {
      bundleId: row.bundle_id,
      recordsSha256: row.records_sha256,
      appliedAt: row.applied_at,
    };
  }

  public applyImportedBundle(input: ImportedMemoryBundleInput): AppliedMemoryBundleResult {
    if (this.options.mode !== "reader") {
      return {
        outcome: "BLOCKED",
        bundleId: input.bundleId,
        recordsSha256: input.recordsSha256,
        appliedAt: input.appliedAt,
        importedCount: 0,
        reason: "Memory bundle import requires reader mode",
      };
    }
    const snapshotInput = snapshotImportedBundleInput(input);
    assertImportedBundleInput(snapshotInput, this.options.scopeId, this.options.writerId);
    let writeDatabase: DatabaseSync | undefined;
    let transactionStarted = false;
    try {
      writeDatabase = new DatabaseSync(this.options.databasePath);
      writeDatabase.exec("BEGIN IMMEDIATE");
      transactionStarted = true;
      const scopeOwner = writeDatabase
        .prepare("SELECT writer_id, workspace_path FROM memory_scopes WHERE scope_id = ?")
        .get(this.options.scopeId) as { readonly writer_id: string; readonly workspace_path: string } | undefined;
      if (scopeOwner === undefined) {
        writeDatabase.prepare("INSERT INTO memory_scopes (scope_id, writer_id, workspace_path) VALUES (?, ?, ?)")
          .run(this.options.scopeId, this.options.writerId, this.options.workspacePath);
      } else if (scopeOwner.writer_id !== this.options.writerId || scopeOwner.workspace_path !== this.options.workspacePath) {
        writeDatabase.exec("ROLLBACK");
        transactionStarted = false;
        return {
          outcome: "BLOCKED",
          bundleId: snapshotInput.bundleId,
          recordsSha256: snapshotInput.recordsSha256,
          appliedAt: snapshotInput.appliedAt,
          importedCount: 0,
          reason: scopeOwner.writer_id !== this.options.writerId
            ? `Memory scope ${this.options.scopeId} is owned by writer ${scopeOwner.writer_id}`
            : `Memory scope ${this.options.scopeId} is bound to a different workspace`,
        };
      }
      const existingReceipt = writeDatabase
        .prepare("SELECT bundle_id, records_sha256, applied_at FROM applied_bundles WHERE scope_id = ? AND bundle_id = ?")
        .get(this.options.scopeId, snapshotInput.bundleId) as { readonly bundle_id: string; readonly records_sha256: string; readonly applied_at: string } | undefined;
      if (existingReceipt !== undefined) {
        writeDatabase.exec("ROLLBACK");
        transactionStarted = false;
        if (existingReceipt.records_sha256 === snapshotInput.recordsSha256) {
          return {
            outcome: "NOOP_DUPLICATE",
            bundleId: snapshotInput.bundleId,
            recordsSha256: snapshotInput.recordsSha256,
            appliedAt: existingReceipt.applied_at,
            importedCount: 0,
          };
        }
        return {
          outcome: "BLOCKED",
          bundleId: snapshotInput.bundleId,
          recordsSha256: snapshotInput.recordsSha256,
          appliedAt: snapshotInput.appliedAt,
          importedCount: 0,
          reason: "Bundle ID was already applied with a different records digest",
        };
      }
      if (snapshotInput.records.length > 0) {
        const latest = writeDatabase
          .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM memory_records WHERE scope_id = ? AND writer_id = ?")
          .get(this.options.scopeId, this.options.writerId) as { readonly sequence: number };
        const expectedSequence = latest.sequence + 1;
        if (snapshotInput.records[0]!.sequence !== expectedSequence) {
          writeDatabase.exec("ROLLBACK");
          transactionStarted = false;
          return {
            outcome: "BLOCKED",
            bundleId: snapshotInput.bundleId,
            recordsSha256: snapshotInput.recordsSha256,
            appliedAt: snapshotInput.appliedAt,
            importedCount: 0,
            reason: `Memory bundle must begin at reader sequence ${expectedSequence}`,
          };
        }
      }
      for (const record of snapshotInput.records) {
        const existingRecord = writeDatabase
          .prepare("SELECT value_sha256 FROM memory_records WHERE scope_id = ? AND memory_id = ?")
          .get(this.options.scopeId, record.memoryId) as { readonly value_sha256: string } | undefined;
        if (existingRecord !== undefined) {
          writeDatabase.exec("ROLLBACK");
          transactionStarted = false;
          return {
            outcome: "BLOCKED",
            bundleId: snapshotInput.bundleId,
            recordsSha256: snapshotInput.recordsSha256,
            appliedAt: snapshotInput.appliedAt,
            importedCount: 0,
            reason: `Memory ID ${record.memoryId} already exists`,
          };
        }
        const existingSequence = writeDatabase
          .prepare("SELECT memory_id FROM memory_records WHERE scope_id = ? AND writer_id = ? AND sequence = ?")
          .get(this.options.scopeId, record.writerId, record.sequence) as { readonly memory_id: string } | undefined;
        if (existingSequence !== undefined) {
          writeDatabase.exec("ROLLBACK");
          transactionStarted = false;
          return {
            outcome: "BLOCKED",
            bundleId: snapshotInput.bundleId,
            recordsSha256: snapshotInput.recordsSha256,
            appliedAt: snapshotInput.appliedAt,
            importedCount: 0,
            reason: `Memory sequence ${record.sequence} already exists`,
          };
        }
      }

      for (const record of snapshotInput.records) {
        writeDatabase.prepare("INSERT INTO memory_records (scope_id, memory_id, writer_id, sequence, value_json, value_sha256, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(record.scopeId, record.memoryId, record.writerId, record.sequence, canonicalJson(record.value), record.valueSha256, record.recordedAt);
      }
      writeDatabase.prepare("INSERT INTO applied_bundles (scope_id, bundle_id, records_sha256, applied_at) VALUES (?, ?, ?, ?)")
        .run(this.options.scopeId, snapshotInput.bundleId, snapshotInput.recordsSha256, snapshotInput.appliedAt);
      writeDatabase.exec("COMMIT");
      return {
        outcome: "IMPORTED",
        bundleId: snapshotInput.bundleId,
        recordsSha256: snapshotInput.recordsSha256,
        appliedAt: snapshotInput.appliedAt,
        importedCount: snapshotInput.records.length,
      };
    } catch (error) {
      const hadActiveTransaction = transactionStarted;
      if (transactionStarted && writeDatabase !== undefined) {
        writeDatabase.exec("ROLLBACK");
        transactionStarted = false;
      }
      if (hadActiveTransaction) {
        return {
          outcome: "BLOCKED",
          bundleId: snapshotInput.bundleId,
          recordsSha256: snapshotInput.recordsSha256,
          appliedAt: snapshotInput.appliedAt,
          importedCount: 0,
          reason: error instanceof Error ? error.message : "Memory bundle transaction failed",
        };
      }
      throw error;
    } finally {
      if (writeDatabase !== undefined && writeDatabase !== this.database) writeDatabase.close();
    }
  }

  public async put(input: PutMemoryInput): Promise<MemoryRecord> {
    if (this.options.mode !== "writer") {
      throw new InvalidTaskStateError("Memory put is blocked in reader mode");
    }
    const value = snapshotMemoryValue(input.value);
    const memoryId = assertIdentifier(input.memoryId, "Memory memoryId");
    const recordedAt = assertRecordedAt(input.recordedAt);
    assertNoSecretShapedValue(value);
    const valueJson = canonicalJson(value);
    const valueSha256 = createHash("sha256").update(valueJson, "utf8").digest("hex");

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database
        .prepare("SELECT memory_id FROM memory_records WHERE scope_id = ? AND memory_id = ?")
        .get(this.options.scopeId, memoryId) as { readonly memory_id: string } | undefined;
      if (existing !== undefined) {
        throw new InvalidTaskStateError(`Memory ${memoryId} already exists in scope ${this.options.scopeId}`);
      }
      const latest = this.database
        .prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM memory_records WHERE scope_id = ? AND writer_id = ?")
        .get(this.options.scopeId, this.options.writerId) as { readonly sequence: number };
      const sequence = latest.sequence + 1;
      this.database
        .prepare("INSERT INTO memory_records (scope_id, memory_id, writer_id, sequence, value_json, value_sha256, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(this.options.scopeId, memoryId, this.options.writerId, sequence, valueJson, valueSha256, recordedAt);
      this.database.exec("COMMIT");
      return {
        memoryId,
        scopeId: this.options.scopeId,
        writerId: this.options.writerId,
        sequence,
        value,
        valueSha256,
        recordedAt,
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public async get(memoryId: string): Promise<MemoryRecord | null> {
    const normalizedMemoryId = assertIdentifier(memoryId, "Memory memoryId");
    const row = this.database
      .prepare("SELECT memory_id, scope_id, writer_id, sequence, value_json, value_sha256, recorded_at FROM memory_records WHERE scope_id = ? AND memory_id = ?")
      .get(this.options.scopeId, normalizedMemoryId) as MemoryRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  public close(): void {
    this.database.close();
  }
}
