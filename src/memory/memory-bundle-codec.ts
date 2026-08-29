import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { containsSecretShapedValue } from "../domain/manifest-id.js";
import { InvalidTaskStateError } from "../domain/errors.js";
import type { LocalSqliteMemoryStoreOptions, MemoryRecord, MemoryValue } from "./types.js";
import { LocalSqliteMemoryStore } from "./local-sqlite-memory-store.js";

export interface MemoryBundleManifest {
  readonly formatVersion: 1;
  readonly bundleId: string;
  readonly scopeId: string;
  readonly writerId: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly recordCount: number;
  readonly recordsSha256: string;
  readonly createdAt: string;
}

export interface MemoryBundle {
  readonly bundleDirectory: string;
  readonly manifest: MemoryBundleManifest;
  readonly records: readonly MemoryRecord[];
  readonly recordsJsonl: string;
}

export interface ExportMemoryBundleOptions {
  readonly bundleId?: string;
  readonly createdAt?: string;
  readonly afterSequence?: number;
}

export type MemoryImportOutcome = "IMPORTED" | "NOOP_DUPLICATE" | "BLOCKED";

export interface MemoryImportReceipt {
  readonly outcome: MemoryImportOutcome;
  readonly bundleId: string | null;
  readonly recordsSha256: string | null;
  readonly appliedAt: string | null;
  readonly importedCount: number;
  readonly reason?: string;
}

interface BundleInput {
  readonly bundleId: string;
  readonly scopeId: string;
  readonly writerId: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly recordCount: number;
  readonly recordsSha256: string;
  readonly createdAt: string;
}

const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new InvalidTaskStateError("Memory value contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new InvalidTaskStateError("Memory value must be JSON data");
  const object = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(object);
  if (prototype !== Object.prototype && prototype !== null) throw new InvalidTaskStateError("Memory value must be JSON data");
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function isMemoryValue(value: unknown): value is MemoryValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isMemoryValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value).every(isMemoryValue);
}

function assertSafeIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !safeIdentifierPattern.test(value)) {
    throw new InvalidTaskStateError(`${label} must use 1-128 safe identifier characters`);
  }
  if (containsSecretShapedValue(value)) {
    throw new InvalidTaskStateError(`${label} must not contain secret-shaped content`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new InvalidTaskStateError(`${label} must be a SHA-256 hex digest`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new InvalidTaskStateError(`${label} must be an ISO timestamp`);
  }
}

function blocked(reason: string, bundleId: string | null = null, recordsSha256: string | null = null): MemoryImportReceipt {
  return { outcome: "BLOCKED", bundleId, recordsSha256, appliedAt: null, importedCount: 0, reason };
}

function parseManifest(value: unknown): BundleInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InvalidTaskStateError("Bundle manifest must be an object");
  const manifest = value as Record<string, unknown>;
  const required = ["formatVersion", "bundleId", "scopeId", "writerId", "fromSequence", "toSequence", "recordCount", "recordsSha256", "createdAt"];
  if (Object.keys(manifest).some((key) => !required.includes(key)) || required.some((key) => !(key in manifest))) throw new InvalidTaskStateError("Memory bundle manifest schema is invalid");
  if (manifest.formatVersion !== 1) throw new InvalidTaskStateError("Unsupported memory bundle format version");
  assertSafeIdentifier(manifest.bundleId, "Memory bundleId");
  assertSafeIdentifier(manifest.scopeId, "Memory scopeId");
  assertSafeIdentifier(manifest.writerId, "Memory writerId");
  for (const [key, candidate] of [["fromSequence", manifest.fromSequence], ["toSequence", manifest.toSequence], ["recordCount", manifest.recordCount]]) {
    if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < 0) throw new InvalidTaskStateError(`Memory manifest ${key} must be a non-negative integer`);
  }
  if ((manifest.recordCount as number) === 0) {
    if (manifest.fromSequence !== 0 || manifest.toSequence !== 0) throw new InvalidTaskStateError("Empty bundle must have a zero sequence range");
  } else if ((manifest.fromSequence as number) < 1 || (manifest.toSequence as number) < (manifest.fromSequence as number)) {
    throw new InvalidTaskStateError("Memory manifest sequence range is invalid");
  }
  assertSha256(manifest.recordsSha256, "Memory recordsSha256");
  assertTimestamp(manifest.createdAt, "Memory manifest createdAt");
  return manifest as unknown as BundleInput;
}

function parseRecords(recordsJsonl: string, manifest: BundleInput): MemoryRecord[] {
  if (containsSecretShapedValue(recordsJsonl)) throw new InvalidTaskStateError("Secret-shaped memory bundle input is not permitted");
  const lines = recordsJsonl.length === 0 ? [] : recordsJsonl.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.some((line) => line.length === 0)) throw new InvalidTaskStateError("Memory bundle JSONL contains a blank line");
  if (lines.length !== manifest.recordCount) throw new InvalidTaskStateError("Memory bundle record count does not match its manifest");
  const records: MemoryRecord[] = [];
  const memoryIds = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]!);
    } catch {
      throw new InvalidTaskStateError(`Memory bundle record ${index + 1} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new InvalidTaskStateError("Memory bundle record must be an object");
    const record = parsed as Record<string, unknown>;
    const required = ["memoryId", "scopeId", "writerId", "sequence", "value", "valueSha256", "recordedAt"];
    if (Object.keys(record).some((key) => !required.includes(key)) || required.some((key) => !(key in record))) throw new InvalidTaskStateError("Memory bundle record schema is invalid");
    assertSafeIdentifier(record.memoryId, "Memory memoryId");
    if (memoryIds.has(record.memoryId)) throw new InvalidTaskStateError(`Memory bundle contains duplicate ID ${record.memoryId}`);
    memoryIds.add(record.memoryId);
    assertSafeIdentifier(record.scopeId, "Memory scopeId");
    assertSafeIdentifier(record.writerId, "Memory writerId");
    if (record.scopeId !== manifest.scopeId || record.writerId !== manifest.writerId) throw new InvalidTaskStateError("Memory bundle record identity does not match its manifest");
    if (typeof record.sequence !== "number" || !Number.isSafeInteger(record.sequence) || record.sequence !== manifest.fromSequence + index) throw new InvalidTaskStateError("Memory bundle records must be strictly ordered and contiguous");
    if (!isMemoryValue(record.value)) throw new InvalidTaskStateError("Memory bundle value is not JSON data");
    assertSha256(record.valueSha256, "Memory valueSha256");
    if (sha256(canonicalJson(record.value)) !== record.valueSha256) throw new InvalidTaskStateError(`Memory value hash mismatch for ${record.memoryId}`);
    assertTimestamp(record.recordedAt, "Memory recordedAt");
    if (containsSecretShapedValue(canonicalJson(record.value))) throw new InvalidTaskStateError("Secret-shaped memory bundle input is not permitted");
    if (lines[index] !== canonicalJson(record)) throw new InvalidTaskStateError("Memory bundle JSONL is not canonical");
    records.push(record as unknown as MemoryRecord);
  }
  if (records.length > 0 && records[records.length - 1]!.sequence !== manifest.toSequence) throw new InvalidTaskStateError("Memory bundle sequence range does not match its records");
  return records;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeExactUtf8(bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InvalidTaskStateError("Memory bundle records must be valid UTF-8");
  }
  if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes))) {
    throw new InvalidTaskStateError("Memory bundle records bytes are not exact UTF-8");
  }
  return decoded;
}

export async function exportMemoryBundle(
  store: LocalSqliteMemoryStore,
  bundleDirectory: string,
  options: ExportMemoryBundleOptions | string = {},
): Promise<MemoryBundle> {
  const normalizedOptions: ExportMemoryBundleOptions = typeof options === "string" ? { bundleId: options } : options;
  const bundleId = normalizedOptions.bundleId ?? randomUUID();
  assertSafeIdentifier(bundleId, "Memory bundleId");
  const afterSequence = normalizedOptions.afterSequence ?? 0;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new InvalidTaskStateError("Memory export afterSequence must be a non-negative integer");
  const records = await store.listAfter(afterSequence);
  const recordsJsonl = records.map((record) => canonicalJson(record)).join("\n") + (records.length > 0 ? "\n" : "");
  const manifest: MemoryBundleManifest = {
    formatVersion: 1,
    bundleId,
    scopeId: store.scopeId,
    writerId: store.writerId,
    fromSequence: records[0]?.sequence ?? 0,
    toSequence: records[records.length - 1]?.sequence ?? 0,
    recordCount: records.length,
    recordsSha256: sha256(recordsJsonl),
    createdAt: normalizedOptions.createdAt ?? new Date().toISOString(),
  };
  assertTimestamp(manifest.createdAt, "Memory manifest createdAt");
  const manifestJson = `${canonicalJson(manifest)}\n`;
  if (containsSecretShapedValue(recordsJsonl) || containsSecretShapedValue(manifestJson)) {
    throw new InvalidTaskStateError("Secret-shaped memory bundle output is not permitted");
  }
  await mkdir(bundleDirectory, { recursive: true });
  await writeFile(join(bundleDirectory, "records.jsonl"), recordsJsonl, "utf8");
  await writeFile(join(bundleDirectory, "manifest.json"), manifestJson, "utf8");
  return { bundleDirectory, manifest, records, recordsJsonl };
}

export async function importMemoryBundle(
  target: LocalSqliteMemoryStore | LocalSqliteMemoryStoreOptions,
  bundleDirectory: string,
): Promise<MemoryImportReceipt> {
  if ((target instanceof LocalSqliteMemoryStore ? target.mode : target.mode) !== "reader") {
    return blocked("Memory bundle import requires reader mode");
  }
  let manifestText: string;
  let recordsBytes: Buffer;
  let parsedManifest: BundleInput | undefined;
  try {
    [manifestText, recordsBytes] = await Promise.all([
      readFile(join(bundleDirectory, "manifest.json"), "utf8"),
      readFile(join(bundleDirectory, "records.jsonl")),
    ]);
    const recordsJsonl = decodeExactUtf8(recordsBytes);
    if (containsSecretShapedValue(manifestText)) return blocked("Secret-shaped memory bundle input is not permitted");
    const manifest = parseManifest(JSON.parse(manifestText) as unknown);
    parsedManifest = manifest;
    const configuredScopeId = target instanceof LocalSqliteMemoryStore ? target.scopeId : target.scopeId;
    const configuredWriterId = target instanceof LocalSqliteMemoryStore ? target.writerId : target.writerId;
    if (manifest.scopeId !== configuredScopeId) return blocked("Memory bundle scope does not match the reader scope", manifest.bundleId, manifest.recordsSha256);
    if (manifest.writerId !== configuredWriterId) return blocked("Memory bundle writer does not match the configured writer", manifest.bundleId, manifest.recordsSha256);
    if (createHash("sha256").update(recordsBytes).digest("hex") !== manifest.recordsSha256) return blocked("Memory bundle records digest does not match its manifest", manifest.bundleId, manifest.recordsSha256);
    const records = parseRecords(recordsJsonl, manifest);
    if (!(target instanceof LocalSqliteMemoryStore) && records.length > 0 && !existsSync(target.databasePath) && records[0]!.sequence !== 1) {
      return blocked("Memory bundle must begin at reader sequence 1", manifest.bundleId, manifest.recordsSha256);
    }
    let store: LocalSqliteMemoryStore;
    let ownsStore = false;
    if (target instanceof LocalSqliteMemoryStore) {
      store = target;
    } else {
      LocalSqliteMemoryStore.initializeReaderDatabase(target);
      store = new LocalSqliteMemoryStore(target);
      ownsStore = true;
    }
    try {
      const result = store.applyImportedBundle({
      bundleId: manifest.bundleId,
      recordsSha256: manifest.recordsSha256,
      records,
      recordsBytes,
      appliedAt: manifest.createdAt,
      });
      return result;
    } finally {
      if (ownsStore) store.close();
    }
  } catch (error) {
    return blocked(
      error instanceof Error ? error.message : "Memory bundle validation failed",
      parsedManifest?.bundleId ?? null,
      parsedManifest?.recordsSha256 ?? null,
    );
  }
}
