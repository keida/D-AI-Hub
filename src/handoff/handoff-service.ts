import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

// A local persistence transaction must finish within this fixed, fail-closed bound.
export const FILE_HANDOFF_LOCK_LEASE_MS = 30_000;
const fileHandoffLockRetryMs = 10;
const fileHandoffLockAcquireMarginMs = 1_000;
const fileHandoffLockOwnerFile = "owner";
const fileHandoffLockLeaseFile = "lease";
const fileHandoffLockReleasedFile = "released";

interface FileLockOwner { readonly lockPath: string; readonly token: string; }
interface FileLockGeneration { readonly lockPath: string; readonly generation: bigint; }
export interface FileHandoffPersistenceOptions { readonly afterReleaseLockQuarantine: (() => Promise<void>) | null; }

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
  private readonly afterReleaseLockQuarantine: (() => Promise<void>) | null;
  public constructor(filePath: string);
  public constructor(filePath: string, options: FileHandoffPersistenceOptions);
  public constructor(private readonly filePath: string, options?: FileHandoffPersistenceOptions) { this.afterReleaseLockQuarantine = options === undefined ? null : options.afterReleaseLockQuarantine; }
  public async load(): Promise<readonly HandoffPersistenceRecord[]> {
    try {
      await this.assertCurrentLockOwnership();
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
      await this.assertCurrentLockOwnership();
      const normalized = parsePersistenceRecords({ records: records.map(cloneRecord) });
      const parent = dirname(this.filePath);
      temporaryPath = join(parent, `.${basename(this.filePath)}.${randomUUID()}.tmp`);
      await mkdir(parent, { recursive: true });
      await writeFile(temporaryPath, JSON.stringify({ records: normalized, integrityHash: persistenceHash(normalized) }), { encoding: "utf8", flag: "wx" });
      await this.assertCurrentLockOwnership();
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
    try {
      return await this.lockOwners.run(owner, async () => {
        const result = await operation();
        await this.assertLockOwnership(owner);
        return result;
      });
    } finally {
      await this.releaseLock(owner);
    }
  }
  private async acquireLock(lockPath: string): Promise<FileLockOwner> {
    const acquisitionDeadline = Date.now() + FILE_HANDOFF_LOCK_LEASE_MS + fileHandoffLockAcquireMarginMs;
    await mkdir(lockPath, { recursive: true });
    while (Date.now() <= acquisitionDeadline) {
      const latest = await this.latestLockGeneration(lockPath);
      if (latest !== null && !await this.isLockReleased(latest.lockPath) && !await this.isLockExpired(latest.lockPath)) {
        const remainingWaitMs = acquisitionDeadline - Date.now();
        if (remainingWaitMs <= 0) break;
        await new Promise<void>((resolve) => { setTimeout(resolve, Math.min(fileHandoffLockRetryMs, remainingWaitMs)); });
        continue;
      }
      const generation = (latest === null ? 0n : latest.generation) + 1n;
      const generationPath = join(lockPath, generation.toString());
      try {
        await mkdir(generationPath);
        const owner: FileLockOwner = { lockPath: generationPath, token: randomUUID() };
        try {
          await writeFile(join(generationPath, fileHandoffLockOwnerFile), owner.token, { encoding: "utf8", flag: "wx" });
          await writeFile(join(generationPath, fileHandoffLockLeaseFile), owner.token, { encoding: "utf8", flag: "wx" });
          return owner;
        } catch (error) {
          throw new InvalidHandoffError(`Unable to initialize handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") continue;
        if (error instanceof InvalidHandoffError) throw error;
        throw new InvalidHandoffError(`Unable to acquire handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new InvalidHandoffError(`Timed out acquiring handoff persistence lock at ${this.filePath}`);
  }
  private async latestLockGeneration(lockPath: string): Promise<FileLockGeneration | null> {
    const entries = await readdir(lockPath, { withFileTypes: true });
    let latest: FileLockGeneration | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) throw new InvalidHandoffError(`Invalid handoff persistence lock generation at ${this.filePath}: ${entry.name}`);
      const generation = BigInt(entry.name);
      if (latest === null || generation > latest.generation) latest = { lockPath: join(lockPath, entry.name), generation };
    }
    return latest;
  }
  private async isLockReleased(lockPath: string): Promise<boolean> {
    let releasedToken: string;
    try {
      releasedToken = await readFile(join(lockPath, fileHandoffLockReleasedFile), "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
      throw new InvalidHandoffError(`Unable to inspect released handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const [ownerToken, leaseToken] = await Promise.all([
        readFile(join(lockPath, fileHandoffLockOwnerFile), "utf8"),
        readFile(join(lockPath, fileHandoffLockLeaseFile), "utf8"),
      ]);
      if (releasedToken !== ownerToken || releasedToken !== leaseToken) throw new InvalidHandoffError(`Invalid released handoff persistence lock at ${this.filePath}`);
      return true;
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      throw new InvalidHandoffError(`Unable to verify released handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
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
  private async releaseLock(owner: FileLockOwner): Promise<void> {
    try {
      await this.assertLockOwnership(owner);
      if (this.afterReleaseLockQuarantine !== null) await this.afterReleaseLockQuarantine();
      await writeFile(join(owner.lockPath, fileHandoffLockReleasedFile), owner.token, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error instanceof InvalidHandoffError) throw error;
      throw new InvalidHandoffError(`Unable to release handoff persistence lock at ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private async assertCurrentLockOwnership(): Promise<void> {
    const owner = this.lockOwners.getStore();
    if (owner === undefined) return;
    await this.assertLockOwnership(owner);
  }
  private async assertLockOwnership(owner: FileLockOwner): Promise<void> {
    try {
      const [ownerToken, leaseToken, leaseStats] = await Promise.all([
        readFile(join(owner.lockPath, fileHandoffLockOwnerFile), "utf8"),
        readFile(join(owner.lockPath, fileHandoffLockLeaseFile), "utf8"),
        stat(join(owner.lockPath, fileHandoffLockLeaseFile)),
      ]);
      if (ownerToken !== owner.token || leaseToken !== owner.token) throw new InvalidHandoffError(`Handoff persistence lock ownership was lost at ${this.filePath}`);
      if (!leaseStats.isFile()) throw new InvalidHandoffError(`Invalid handoff persistence lock at ${this.filePath}: lease path is not a file`);
      if (Date.now() - leaseStats.mtimeMs > FILE_HANDOFF_LOCK_LEASE_MS) throw new InvalidHandoffError(`Handoff persistence lock lease expired at ${this.filePath}`);
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
