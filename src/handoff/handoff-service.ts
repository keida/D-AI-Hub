import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { CapabilityMismatchError, InvalidHandoffError, InvalidTaskStateError } from "../domain/errors.js";
import type { Environment, TaskState } from "../domain/types.js";
import type { EnvironmentCapabilities } from "../routing/environment-capabilities.js";
import { createHandoffEnvelope, handoffEnvelopeSchema, parseHandoffEnvelope, validateHandoffCreateInput, type HandoffEnvelope } from "./envelope.js";

export interface HandoffService {
  ready(): Promise<void>;
  create(input: { readonly state: TaskState; readonly targetEnvironment: Environment }): Promise<HandoffEnvelope>;
  acknowledge(envelope: HandoffEnvelope, target: EnvironmentCapabilities): Promise<void>;
  complete(handoffId: string, recipient: Environment): Promise<void>;
  reject(handoffId: string, reason: string): Promise<void>;
}

export interface HandoffStatus { readonly handoffId: string; readonly state: "pending" | "active" | "completed" | "rejected"; readonly reason: string | null; readonly owner: Environment | null; }
export interface HandoffPersistenceRecord { readonly envelope: HandoffEnvelope; readonly owner: Environment | null; readonly state: HandoffStatus["state"]; readonly reason: string | null; }
export interface HandoffPersistence { load(): Promise<readonly HandoffPersistenceRecord[]>; save(records: readonly HandoffPersistenceRecord[]): Promise<void>; withExclusive<T>(operation: () => Promise<T>): Promise<T>; }

const environmentSchema = z.enum(["chat", "work", "codex"]);
const targetSchema = z.object({ environment: environmentSchema, capabilities: z.set(z.string()) }).strict();
const handoffIdSchema = z.string().regex(/^handoff-[A-Za-z0-9._-]+-[1-9][0-9]*$/);
const reasonSchema = z.string().trim().min(1);
const persistedRecordSchema = z.object({ envelope: handoffEnvelopeSchema, owner: environmentSchema.nullable(), state: z.enum(["pending", "active", "completed", "rejected"]), reason: z.string().nullable() }).strict();
const persistedRecordsSchema = z.object({ records: z.array(persistedRecordSchema) }).strict();
const persistenceDocumentSchema = persistedRecordsSchema.extend({ integrityHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

export const FILE_HANDOFF_LOCK_LEASE_MS = 300;
const fileHandoffLockRefreshMs = 50;
const fileHandoffLockRetryMs = 10;
const fileHandoffLockAttempts = 200;
const fileHandoffLockOwnerFile = "owner";
const fileHandoffLockLeaseFile = "lease";

interface FileLockOwner { readonly lockPath: string; readonly token: string; }

function issueReason(result: { readonly error: z.ZodError }): string { const issue = result.error.issues[0]; return issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`; }
function parseTarget(target: EnvironmentCapabilities): EnvironmentCapabilities { const result = targetSchema.safeParse(target); if (!result.success) throw new CapabilityMismatchError(`Invalid handoff target capabilities: ${issueReason(result)}`); return { environment: result.data.environment, capabilities: new Set(result.data.capabilities) }; }
function parseHandoffId(handoffId: string): string { const result = handoffIdSchema.safeParse(handoffId); if (!result.success) throw new InvalidHandoffError(`Invalid handoff id: ${issueReason(result)}`); return result.data; }
function parseRecipient(recipient: Environment): Environment { const result = environmentSchema.safeParse(recipient); if (!result.success) throw new InvalidHandoffError(`Invalid handoff recipient: ${issueReason(result)}`); return result.data; }
function parseReason(reason: string): string { const result = reasonSchema.safeParse(reason); if (!result.success) throw new InvalidTaskStateError(`Handoff rejection reason must be actionable and non-empty: ${issueReason(result)}`); return result.data; }

function parsePersistenceRecords(value: object): readonly HandoffPersistenceRecord[] {
  const result = persistedRecordsSchema.safeParse(value);
  if (!result.success) throw new InvalidHandoffError(`Invalid persisted handoff records: ${issueReason(result)}`);
  return result.data.records.map((record) => {
    const envelope = parseHandoffEnvelope(record.envelope);
    const hasActionableReason = record.reason !== null && reasonSchema.safeParse(record.reason).success;
    const ownerMatchesTarget = record.owner === envelope.targetEnvironment;
    if (record.state === "pending" && (record.owner !== null || record.reason !== null)) throw new InvalidHandoffError(`Invalid persisted handoff lifecycle for ${envelope.handoffId}: pending records require a null owner and reason`);
    if (record.state === "active" && (!ownerMatchesTarget || record.reason !== null)) throw new InvalidHandoffError(`Invalid persisted handoff lifecycle for ${envelope.handoffId}: active records require the target owner and a null reason`);
    if (record.state === "completed" && (!ownerMatchesTarget || !hasActionableReason)) throw new InvalidHandoffError(`Invalid persisted handoff lifecycle for ${envelope.handoffId}: completed records require the target owner and an actionable reason`);
    if (record.state === "rejected" && (!hasActionableReason || (record.owner !== null && !ownerMatchesTarget))) throw new InvalidHandoffError(`Invalid persisted handoff lifecycle for ${envelope.handoffId}: rejected records require an actionable reason and a null or target owner`);
    return { envelope, owner: record.owner, state: record.state, reason: record.reason };
  });
}

function persistenceHash(records: readonly HandoffPersistenceRecord[]): string { return createHash("sha256").update(JSON.stringify({ records }), "utf8").digest("hex"); }

function cloneRecord(record: HandoffPersistenceRecord): HandoffPersistenceRecord { return { envelope: parseHandoffEnvelope(record.envelope), owner: record.owner, state: record.state, reason: record.reason }; }
function nextSequence(records: ReadonlyMap<string, HandoffPersistenceRecord>, taskId: string): number { return [...records.values()].filter((record) => record.envelope.taskId === taskId).reduce((largest, record) => Math.max(largest, Number(record.envelope.handoffId.slice(record.envelope.handoffId.lastIndexOf("-") + 1))), 0) + 1; }

export class InMemoryHandoffPersistence implements HandoffPersistence {
  private records: readonly HandoffPersistenceRecord[] = [];
  private exclusiveQueue: Promise<void> = Promise.resolve();
  public async load(): Promise<readonly HandoffPersistenceRecord[]> { return parsePersistenceRecords({ records: this.records.map(cloneRecord) }); }
  public async save(records: readonly HandoffPersistenceRecord[]): Promise<void> { this.records = parsePersistenceRecords({ records: records.map(cloneRecord) }); }
  public async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.exclusiveQueue;
    let release: () => void = () => {};
    this.exclusiveQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export class FileHandoffPersistence implements HandoffPersistence {
  private readonly lockOwners = new AsyncLocalStorage<FileLockOwner>();
  public constructor(private readonly filePath: string) {}
  public async load(): Promise<readonly HandoffPersistenceRecord[]> {
    try {
      await this.refreshCurrentLockLease();
      let content: string;
      try { content = await readFile(this.filePath, "utf8"); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return []; throw error; }
      const parsedDocument: object = JSON.parse(content);
      const document = persistenceDocumentSchema.safeParse(parsedDocument);
      if (!document.success) throw new InvalidHandoffError(`Invalid handoff persistence at ${this.filePath}: ${issueReason(document)}`);
      const records = parsePersistenceRecords({ records: document.data.records });
      if (document.data.integrityHash !== persistenceHash(records)) throw new InvalidHandoffError(`Invalid handoff persistence at ${this.filePath}: integrity hash mismatch`);
      return records;
    } catch (error) { if (error instanceof InvalidHandoffError) throw error; throw new InvalidHandoffError(`Invalid handoff persistence at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  public async save(records: readonly HandoffPersistenceRecord[]): Promise<void> {
    let temporaryPath: string | null = null;
    try {
      await this.refreshCurrentLockLease();
      const normalized = parsePersistenceRecords({ records: records.map(cloneRecord) });
      const parent = dirname(this.filePath);
      temporaryPath = join(parent, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
      await mkdir(parent, { recursive: true });
      await writeFile(temporaryPath, JSON.stringify({ records: normalized, integrityHash: persistenceHash(normalized) }), { encoding: "utf8", flag: "wx" });
      await this.refreshCurrentLockLease();
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      if (temporaryPath !== null) await rm(temporaryPath, { force: true });
      if (error instanceof InvalidHandoffError) throw error;
      throw new InvalidHandoffError(`Unable to persist handoffs at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  public async withExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    let owner: FileLockOwner;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      owner = await this.acquireLock(lockPath);
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      throw new InvalidHandoffError(`Unable to prepare handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let refreshFailure: InvalidHandoffError | null = null;
    const refreshTimer = setInterval(() => {
      void this.refreshLockLease(owner).catch((error) => {
        refreshFailure = error instanceof InvalidHandoffError ? error : new InvalidHandoffError(`Unable to refresh handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, fileHandoffLockRefreshMs);
    try {
      return await this.lockOwners.run(owner, async () => {
        const result = await operation();
        if (refreshFailure !== null) throw refreshFailure;
        return result;
      });
    } finally {
      clearInterval(refreshTimer);
      await this.releaseLock(owner);
    }
  }
  private async acquireLock(lockPath: string): Promise<FileLockOwner> {
    for (let attempt = 0; attempt < fileHandoffLockAttempts; attempt += 1) {
      try {
        await mkdir(lockPath);
        const owner: FileLockOwner = { lockPath, token: randomUUID() };
        try {
          await writeFile(join(lockPath, fileHandoffLockOwnerFile), owner.token, { encoding: "utf8", flag: "wx" });
          await writeFile(join(lockPath, fileHandoffLockLeaseFile), owner.token, { encoding: "utf8", flag: "wx" });
          return owner;
        } catch (error) {
          await rm(lockPath, { recursive: true, force: false });
          throw error;
        }
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
          await this.reclaimExpiredLock(lockPath);
          await new Promise<void>((resolve) => { setTimeout(resolve, fileHandoffLockRetryMs); });
          continue;
        }
        throw new InvalidHandoffError(`Unable to acquire handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new InvalidHandoffError(`Timed out acquiring handoff persistence lock at ${this.filePath}`);
  }
  private async reclaimExpiredLock(lockPath: string): Promise<void> {
    const expired = await this.isLockExpired(lockPath);
    if (!expired) return;
    const quarantinePath = `${lockPath}.${randomUUID()}.quarantine`;
    try {
      await rename(lockPath, quarantinePath);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw new InvalidHandoffError(`Unable to quarantine expired handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!await this.isLockExpired(quarantinePath)) {
      try {
        await rename(quarantinePath, lockPath);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
          await rm(quarantinePath, { recursive: true, force: false });
          return;
        }
        throw new InvalidHandoffError(`Unable to restore renewed handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    try {
      await rm(quarantinePath, { recursive: true, force: false });
    } catch (error) {
      throw new InvalidHandoffError(`Unable to remove quarantined handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async isLockExpired(lockPath: string): Promise<boolean> {
    try {
      const leaseStats = await stat(join(lockPath, fileHandoffLockLeaseFile));
      if (!leaseStats.isFile()) throw new InvalidHandoffError(`Invalid handoff persistence lock at ${this.filePath}: lease path is not a file`);
      return Date.now() - leaseStats.mtimeMs > FILE_HANDOFF_LOCK_LEASE_MS;
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw new InvalidHandoffError(`Unable to inspect handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const lockStats = await stat(lockPath);
      if (!lockStats.isDirectory()) throw new InvalidHandoffError(`Invalid handoff persistence lock at ${this.filePath}: lock path is not a directory`);
      return Date.now() - lockStats.mtimeMs > FILE_HANDOFF_LOCK_LEASE_MS;
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
      throw new InvalidHandoffError(`Unable to inspect handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async refreshLockLease(owner: FileLockOwner): Promise<void> {
    const refreshedAt = new Date();
    try {
      await this.assertLockOwnership(owner);
      await utimes(join(owner.lockPath, fileHandoffLockLeaseFile), refreshedAt, refreshedAt);
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      throw new InvalidHandoffError(`Unable to refresh handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async releaseLock(owner: FileLockOwner): Promise<void> {
    try {
      await this.assertLockOwnership(owner);
      await rm(owner.lockPath, { recursive: true, force: false });
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      throw new InvalidHandoffError(`Unable to release handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async refreshCurrentLockLease(): Promise<void> {
    const owner = this.lockOwners.getStore();
    if (owner === undefined) return;
    await this.refreshLockLease(owner);
  }
  private async assertLockOwnership(owner: FileLockOwner): Promise<void> {
    try {
      const [ownerToken, leaseToken] = await Promise.all([
        readFile(join(owner.lockPath, fileHandoffLockOwnerFile), "utf8"),
        readFile(join(owner.lockPath, fileHandoffLockLeaseFile), "utf8"),
      ]);
      if (ownerToken !== owner.token || leaseToken !== owner.token) throw new InvalidHandoffError(`Handoff persistence lock ownership was lost at ${this.filePath}`);
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      throw new InvalidHandoffError(`Unable to verify handoff persistence lock ownership at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export class PersistentHandoffService implements HandoffService {
  private readonly records = new Map<string, HandoffPersistenceRecord>();
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  public constructor(private readonly persistence: HandoffPersistence) {}

  public async create(input: { readonly state: TaskState; readonly targetEnvironment: Environment }): Promise<HandoffEnvelope> {
    return this.runExclusive(async () => {
      const validated = validateHandoffCreateInput(Object.assign({ handoffId: "handoff-validation-1" }, input));
      await this.initialize();
      const handoffId = `handoff-${validated.state.taskId}-${nextSequence(this.records, validated.state.taskId)}`;
      const envelope = createHandoffEnvelope({ handoffId, state: validated.state, targetEnvironment: validated.targetEnvironment });
      if (this.records.has(envelope.handoffId)) throw new InvalidHandoffError(`Duplicate handoff id: ${envelope.handoffId}`);
      await this.replace({ envelope, owner: null, state: "pending", reason: null });
      return parseHandoffEnvelope(envelope);
    });
  }

  public async acknowledge(envelope: HandoffEnvelope, target: EnvironmentCapabilities): Promise<void> {
    await this.runExclusive(async () => {
      const received = parseHandoffEnvelope(envelope);
      const validatedTarget = parseTarget(target);
      await this.initialize();
      const record = this.requireRecord(received.handoffId);
      if (record.envelope.integrityHash !== received.integrityHash) throw new InvalidHandoffError(`Handoff envelope does not match pending handoff: ${received.handoffId}`);
      if (received.targetEnvironment !== validatedTarget.environment) throw new InvalidHandoffError(`Handoff ${received.handoffId} targets ${received.targetEnvironment}, not ${validatedTarget.environment}`);
      const requiredCapabilities = received.capabilitySnapshot[validatedTarget.environment];
      if (!requiredCapabilities.every((capability) => validatedTarget.capabilities.has(capability))) throw new CapabilityMismatchError(`Handoff target ${validatedTarget.environment} does not cover required capabilities: ${requiredCapabilities.join(", ")}`);
      if (record.owner !== null || record.state !== "pending") throw new InvalidHandoffError(`Handoff ${received.handoffId} already has an active owner or terminal state`);
      await this.replace({ ...record, owner: validatedTarget.environment, state: "active" });
    });
  }

  public async complete(handoffId: string, recipient: Environment): Promise<void> {
    await this.runExclusive(async () => {
      const validatedHandoffId = parseHandoffId(handoffId);
      const validatedRecipient = parseRecipient(recipient);
      await this.initialize();
      const record = this.requireRecord(validatedHandoffId);
      if (record.state !== "active" || record.owner === null) throw new InvalidTaskStateError(`Handoff ${validatedHandoffId} cannot complete from state ${record.state}`);
      if (record.owner !== validatedRecipient) throw new InvalidHandoffError(`Handoff ${validatedHandoffId} is owned by ${record.owner}, not ${validatedRecipient}`);
      await this.replace({ ...record, state: "completed", reason: `Completed by ${validatedRecipient}` });
    });
  }

  public async reject(handoffId: string, reason: string): Promise<void> {
    await this.runExclusive(async () => {
      const validatedHandoffId = parseHandoffId(handoffId);
      const validatedReason = parseReason(reason);
      await this.initialize();
      const record = this.requireRecord(validatedHandoffId);
      if (record.state === "completed" || record.state === "rejected") throw new InvalidTaskStateError(`Handoff ${validatedHandoffId} cannot reject from terminal state ${record.state}`);
      await this.replace({ ...record, state: "rejected", reason: validatedReason });
    });
  }

  public status(handoffId: string): HandoffStatus {
    const validatedHandoffId = parseHandoffId(handoffId);
    if (!this.initialized) throw new InvalidHandoffError("Handoff service must complete an asynchronous lifecycle operation before status is read");
    const record = this.requireRecord(validatedHandoffId);
    return { handoffId: validatedHandoffId, state: record.state, reason: record.reason, owner: record.owner };
  }

  public async ready(): Promise<void> { await this.runExclusive(async () => {}); }

  private async initialize(): Promise<void> {
    if (!this.initialized) await this.refresh();
  }
  private requireRecord(handoffId: string): HandoffPersistenceRecord { const record = this.records.get(handoffId); if (record === undefined) throw new InvalidHandoffError(`Stale or unknown handoff id: ${handoffId}`); return record; }
  private async replace(record: HandoffPersistenceRecord): Promise<void> { const updated = new Map(this.records); updated.set(record.envelope.handoffId, cloneRecord(record)); await this.persistence.save([...updated.values()]); this.records.clear(); for (const value of updated.values()) this.records.set(value.envelope.handoffId, value); }
  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleQueue;
    let release: () => void = () => {};
    this.lifecycleQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.persistence.withExclusive(async () => {
        await this.refresh();
        return operation();
      });
    } finally {
      release();
    }
  }
  private async refresh(): Promise<void> {
    const loaded = new Map<string, HandoffPersistenceRecord>();
    for (const record of parsePersistenceRecords({ records: await this.persistence.load() })) {
      if (loaded.has(record.envelope.handoffId)) throw new InvalidHandoffError(`Duplicate persisted handoff id: ${record.envelope.handoffId}`);
      loaded.set(record.envelope.handoffId, cloneRecord(record));
    }
    this.records.clear();
    for (const record of loaded.values()) this.records.set(record.envelope.handoffId, record);
    this.initialized = true;
  }
}
