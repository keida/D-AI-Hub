import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { CapabilityMismatchError, InvalidHandoffError, InvalidTaskStateError } from "../../src/domain/errors.js";
import type { Environment, TaskState } from "../../src/domain/types.js";
import { FILE_HANDOFF_LOCK_LEASE_MS, FileHandoffPersistence, InMemoryHandoffPersistence, PersistentHandoffService, type HandoffPersistence, type HandoffPersistenceRecord } from "../../src/handoff/handoff-service.js";
import { handoffEnvelopeSignature, validateHandoffCreateInput } from "../../src/handoff/envelope.js";

function state(environment: Environment): TaskState {
  return { taskId: "task-handoff", goal: "Transfer the portable task state", constraints: ["keep scope narrow"], environment, stage: "execute", role: "implementer", routingDecision: null, selectedCapabilities: [], contextManifest: ["workspace:src"], handoffState: "none", verificationEvidence: [], recoveryPoint: null, approvalState: "approved", criticalUnsavedContext: [], durableContext: null };
}

function service(): PersistentHandoffService { return new PersistentHandoffService(new InMemoryHandoffPersistence()); }

class BlockingHandoffPersistence implements HandoffPersistence {
  private readonly delegate = new InMemoryHandoffPersistence();
  private blocked = false;
  private saveStarted: (() => void) | null = null;
  private releaseSave: (() => void) | null = null;
  private readonly saveStartedPromise = new Promise<void>((resolve) => { this.saveStarted = resolve; });

  public blockNextSave(): void { this.blocked = true; }
  public async waitForBlockedSave(): Promise<void> { await this.saveStartedPromise; }
  public releaseBlockedSave(): void {
    if (this.releaseSave === null) throw new Error("No persistence save is blocked");
    this.releaseSave();
    this.releaseSave = null;
  }
  public async load(): Promise<readonly HandoffPersistenceRecord[]> { return this.delegate.load(); }
  public async save(records: readonly HandoffPersistenceRecord[]): Promise<void> {
    if (this.blocked) {
      this.blocked = false;
      this.saveStarted?.();
      await new Promise<void>((resolve) => { this.releaseSave = resolve; });
    }
    await this.delegate.save(records);
  }
  public async withExclusive<T>(operation: () => Promise<T>): Promise<T> { return this.delegate.withExclusive(operation); }
}

class StaticHandoffPersistence implements HandoffPersistence {
  public constructor(private readonly records: readonly HandoffPersistenceRecord[]) {}

  public async load(): Promise<readonly HandoffPersistenceRecord[]> { return this.records; }
  public async save(_records: readonly HandoffPersistenceRecord[]): Promise<void> { throw new Error("Static persistence must not save records"); }
  public async withExclusive<T>(operation: () => Promise<T>): Promise<T> { return operation(); }
}

describe("PersistentHandoffService", () => {
  it.each<[Environment, Environment]>([
    ["chat", "work"],
    ["work", "codex"],
    ["codex", "work"],
    ["codex", "chat"],
    ["work", "chat"],
    ["chat", "codex"],
  ])("transfers the compatible %s to %s path", async (source, target) => {
    const handoffService = service();
    const envelope = await handoffService.create({ state: state(source), targetEnvironment: target });
    const targetAdapter = target === "chat" ? new ChatEnvironmentAdapter(handoffService) : target === "work" ? new WorkEnvironmentAdapter(handoffService) : new CodexEnvironmentAdapter(handoffService);

    await targetAdapter.receive(envelope);

    expect(targetAdapter.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, taskId: envelope.taskId, target, state: "active", reason: null, owner: target });
  });

  it("redacts every secret-like value, including bearer tokens and nested durable data", async () => {
    const source: TaskState = {
      ...state("codex"), goal: "Authorization: Bearer bearer-secret-value", constraints: ["apiKey=api-secret-value"],
      routingDecision: { stage: "execute", environment: "codex", role: "implementer", selectedModel: "model-secret=router-secret", selectedCapabilities: ["token=capability-secret"], reason: "password=reason-secret", overrideSource: "user" },
      verificationEvidence: [{ evidenceId: "evidence-secret=identifier", stage: "execute", environment: "codex", role: "implementer", selectedModel: "secret=model-secret", command: "Authorization: Bearer command-secret-value", observedOutput: "cookie=output-secret", exitCode: 0, interpretation: "credential: interpretation-secret", passed: true, recoveryPointId: "secret=recovery-id", recordedAt: "2026-08-21T00:00:00.000Z" }],
      recoveryPoint: { recoveryPointId: "secret=recovery-point", taskId: "task-handoff", stage: "execute", environment: "codex", role: "implementer", durablePaths: ["secret=path-secret"], hashes: { secretHash: "hash-secret" }, restorationInstructions: "private_key=restore-secret", createdAt: "2026-08-21T00:00:00.000Z" },
      durableContext: { manifestId: "00000000-0000-4000-8000-000000000006", taskId: "task-handoff", stage: "execute", environment: "codex", role: "implementer", durablePaths: ["token=durable-path-secret"], hashes: { accessToken: "manifest-hash-secret" }, recoveryPointId: "secret=manifest-recovery", recordedAt: "2026-08-21T00:00:00.000Z" },
      criticalUnsavedContext: ["session_token=unsaved-secret"],
    };
    Object.defineProperty(source, "rawTranscript", { value: "private conversation" });
    const envelope = await service().create({ state: source, targetEnvironment: "work" });
    const serialized = JSON.stringify(envelope);
    for (const secret of ["bearer-secret-value", "api-secret-value", "router-secret", "capability-secret", "reason-secret", "command-secret-value", "output-secret", "interpretation-secret", "path-secret", "hash-secret", "restore-secret", "durable-path-secret", "manifest-hash-secret", "unsaved-secret", "private conversation"]) expect(serialized).not.toContain(secret);
    expect(envelope.redactions.length).toBeGreaterThan(10);
  });

  it("redacts raw credential signatures before handoff integrity and persistence", async () => {
    const persistence = new InMemoryHandoffPersistence();
    const service = new PersistentHandoffService(persistence);
    const rawSignature = "github_pat_1234567890123456789012345678901234567890";
    const envelope = await service.create({
      state: { ...state("codex"), goal: `Review ${rawSignature}`, contextManifest: [`evidence:${rawSignature}`] },
      targetEnvironment: "work",
    });
    const serialized = JSON.stringify(envelope);

    expect(serialized).not.toContain(rawSignature);
    expect(serialized).toContain("[REDACTED]");
    expect(handoffEnvelopeSignature(envelope)).not.toContain(rawSignature);
    expect((await persistence.load())[0]?.envelope).toEqual(expect.objectContaining({ taskId: envelope.taskId }));
  });

  it("validates malformed create input before dereferencing state or counters", async () => {
    expect(() => validateHandoffCreateInput(null)).toThrow(InvalidTaskStateError);
    expect(() => validateHandoffCreateInput({ state: null, targetEnvironment: "work" })).toThrow(InvalidTaskStateError);
    expect(() => validateHandoffCreateInput({ state: state("chat"), targetEnvironment: null })).toThrow(InvalidTaskStateError);
  });

  it("rejects malformed envelopes and nested identity mismatches", async () => {
    const handoffService = service();
    const envelope = await handoffService.create({ state: state("chat"), targetEnvironment: "work" });
    const malformed = { ...envelope, integrityHash: "0".repeat(64) };
    const routingMismatch = { ...envelope, taskState: { ...envelope.taskState, routingDecision: { stage: "execute" as const, environment: "codex" as const, role: "implementer" as const, selectedModel: "model", selectedCapabilities: [], reason: "reason", overrideSource: "default" as const } } };
    await expect(handoffService.acknowledge(malformed, new WorkEnvironmentAdapter(handoffService).capabilities())).rejects.toThrow(InvalidHandoffError);
    await expect(handoffService.acknowledge(routingMismatch, new WorkEnvironmentAdapter(handoffService).capabilities())).rejects.toThrow(InvalidHandoffError);
    await expect(handoffService.create({ state: { ...state("chat"), routingDecision: { stage: "execute", environment: "codex", role: "implementer", selectedModel: "model", selectedCapabilities: [], reason: "reason", overrideSource: "default" } }, targetEnvironment: "work" })).rejects.toThrow(InvalidHandoffError);
    await expect(handoffService.create({ state: { ...state("chat"), durableContext: { manifestId: "00000000-0000-4000-8000-000000000007", taskId: "other-task", stage: "execute", environment: "chat", role: "implementer", durablePaths: [], hashes: {}, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" } }, targetEnvironment: "work" })).rejects.toThrow(InvalidHandoffError);
    await expect(handoffService.create({ state: { ...state("chat"), recoveryPoint: { recoveryPointId: "recovery", taskId: "other-task", stage: "execute", environment: "chat", role: "implementer", durablePaths: [], hashes: {}, restorationInstructions: "restore", createdAt: "2026-08-21T00:00:00.000Z" } }, targetEnvironment: "work" })).rejects.toThrow(InvalidHandoffError);
    await expect(handoffService.create({ state: { ...state("chat"), verificationEvidence: [{ evidenceId: "evidence", stage: "execute", environment: "codex", role: "implementer", selectedModel: "model", command: "command", observedOutput: "output", exitCode: 0, interpretation: "interpretation", passed: true, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" }] }, targetEnvironment: "work" })).rejects.toThrow(InvalidHandoffError);
  });

  it("requires the verified recipient to complete", async () => {
    const handoffService = service();
    const envelope = await handoffService.create({ state: state("work"), targetEnvironment: "codex" });
    const codex = new CodexEnvironmentAdapter(handoffService);
    await codex.receive(envelope);
    await expect(handoffService.complete(envelope.handoffId, "work")).rejects.toThrow(InvalidHandoffError);
    await codex.complete(envelope.handoffId);
    expect(codex.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, taskId: envelope.taskId, target: "codex", state: "completed", reason: "Completed by codex", owner: "codex" });
  });

  it("persists lifecycle records across service restart and rejects tampered storage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    try {
      const first = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      const envelope = await first.create({ state: state("chat"), targetEnvironment: "work" });
      await new WorkEnvironmentAdapter(first).receive(envelope);
      const restarted = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      await restarted.ready();
      expect(restarted.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, taskId: envelope.taskId, target: "work", state: "active", reason: null, owner: "work" });
      const committedPath = join(`${persistencePath}.lock`, "2", "committed", "snapshot.json");
      await writeFile(committedPath, (await readFile(committedPath, "utf8")).replace('"owner":"work"', '"owner":"codex"'), "utf8");
      const tampered = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      await expect(tampered.ready()).rejects.toThrow(InvalidHandoffError);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("loads the latest state after two saves in one file transaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const envelope = await service().create({ state: state("chat"), targetEnvironment: "work" });
    const latestRecords: readonly HandoffPersistenceRecord[] = [{ envelope, owner: null, state: "pending", reason: null }];
    try {
      const persistence = new FileHandoffPersistence(persistencePath);
      await persistence.withExclusive(async () => {
        await persistence.save([]);
        await persistence.save(latestRecords);
      });

      const restarted = new FileHandoffPersistence(persistencePath);
      let loaded: readonly HandoffPersistenceRecord[] = [];
      await restarted.withExclusive(async () => {
        loaded = await restarted.load();
      });
      expect(loaded).toEqual(latestRecords);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves capability, ownership, and terminal-state checks", async () => {
    const handoffService = service();
    const envelope = await handoffService.create({ state: state("work"), targetEnvironment: "codex" });
    const codex = new CodexEnvironmentAdapter(handoffService);
    await expect(handoffService.acknowledge(envelope, { environment: "codex", capabilities: new Set<string>() })).rejects.toThrow(CapabilityMismatchError);
    await codex.receive(envelope);
    await expect(codex.receive(envelope)).rejects.toThrow(InvalidHandoffError);
    await codex.complete(envelope.handoffId);
    await expect(codex.complete(envelope.handoffId)).rejects.toThrow(InvalidTaskStateError);
    await expect(handoffService.reject(envelope.handoffId, "retry later")).rejects.toThrow(InvalidTaskStateError);
  });

  it("keeps adapters environment-specific", async () => {
    const handoffService = service();
    const envelope = await handoffService.create({ state: state("chat"), targetEnvironment: "work" });
    expect([...new ChatEnvironmentAdapter(handoffService).capabilities().capabilities]).toEqual(["approval", "status"]);
    expect([...new WorkEnvironmentAdapter(handoffService).capabilities().capabilities]).toEqual(["durable-context"]);
    expect([...new CodexEnvironmentAdapter(handoffService).capabilities().capabilities]).toEqual(["local-execution", "codex-evidence"]);
    await expect(new CodexEnvironmentAdapter(handoffService).receive(envelope)).rejects.toThrow(InvalidHandoffError);
  });

  it("serializes concurrent acknowledgements so exactly one owner succeeds", async () => {
    const persistence = new BlockingHandoffPersistence();
    const handoffService = new PersistentHandoffService(persistence);
    const envelope = await handoffService.create({ state: state("chat"), targetEnvironment: "work" });
    const work = new WorkEnvironmentAdapter(handoffService);
    persistence.blockNextSave();

    const first = work.receive(envelope);
    await persistence.waitForBlockedSave();
    const second = work.receive(envelope);
    persistence.releaseBlockedSave();
    const results = await Promise.allSettled([first, second]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("serializes concurrent creation so each successful handoff gets a unique sequence", async () => {
    const persistence = new BlockingHandoffPersistence();
    const handoffService = new PersistentHandoffService(persistence);
    persistence.blockNextSave();

    const first = handoffService.create({ state: state("chat"), targetEnvironment: "work" });
    await persistence.waitForBlockedSave();
    const second = handoffService.create({ state: state("chat"), targetEnvironment: "work" });
    persistence.releaseBlockedSave();
    const envelopes = await Promise.all([first, second]);

    expect(envelopes.map((envelope) => envelope.handoffId)).toEqual(["handoff-task-handoff-1", "handoff-task-handoff-2"]);
  });

  it("serializes concurrent completion and rejection so only one terminal transition succeeds", async () => {
    const persistence = new BlockingHandoffPersistence();
    const handoffService = new PersistentHandoffService(persistence);
    const envelope = await handoffService.create({ state: state("chat"), targetEnvironment: "work" });
    const work = new WorkEnvironmentAdapter(handoffService);
    await work.receive(envelope);
    persistence.blockNextSave();

    const completion = work.complete(envelope.handoffId);
    await persistence.waitForBlockedSave();
    const rejection = handoffService.reject(envelope.handoffId, "Requires review");
    persistence.releaseBlockedSave();
    const results = await Promise.allSettled([completion, rejection]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(work.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, taskId: envelope.taskId, target: "work", state: "completed", reason: "Completed by work", owner: "work" });
  });

  it("coordinates concurrent lifecycle operations across services sharing one file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "nested", "handoffs.json");
    try {
      const first = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      const second = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      const [firstEnvelope, secondEnvelope] = await Promise.all([
        first.create({ state: state("chat"), targetEnvironment: "work" }),
        second.create({ state: state("chat"), targetEnvironment: "work" }),
      ]);

      expect(new Set([firstEnvelope.handoffId, secondEnvelope.handoffId])).toEqual(new Set(["handoff-task-handoff-1", "handoff-task-handoff-2"]));

      const acknowledgement = await first.create({ state: state("chat"), targetEnvironment: "work" });
      const firstWork = new WorkEnvironmentAdapter(first);
      const secondWork = new WorkEnvironmentAdapter(second);
      const results = await Promise.allSettled([firstWork.receive(acknowledgement), secondWork.receive(acknowledgement)]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const restarted = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      await restarted.ready();
      expect(restarted.status(firstEnvelope.handoffId).state).toBe("pending");
      expect(restarted.status(secondEnvelope.handoffId).state).toBe("pending");
      expect(restarted.status(acknowledgement.handoffId)).toEqual({ handoffId: acknowledgement.handoffId, taskId: acknowledgement.taskId, target: "work", state: "active", reason: null, owner: "work" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { state: "pending", owner: "work", reason: null },
    { state: "pending", owner: null, reason: "Awaiting work" },
    { state: "active", owner: null, reason: null },
    { state: "active", owner: "codex", reason: null },
    { state: "active", owner: "work", reason: "Unexpected reason" },
    { state: "completed", owner: null, reason: "Completed by work" },
    { state: "completed", owner: "codex", reason: "Completed by work" },
    { state: "completed", owner: "work", reason: null },
    { state: "completed", owner: "work", reason: "   " },
    { state: "rejected", owner: "codex", reason: "Rejected by another environment" },
    { state: "rejected", owner: null, reason: null },
    { state: "rejected", owner: "work", reason: "   " },
  ] as const)("rejects persisted $state records that violate lifecycle invariants", async ({ state: recordState, owner, reason }) => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    try {
      const envelope = await service().create({ state: state("chat"), targetEnvironment: "work" });
      const records: readonly HandoffPersistenceRecord[] = [{ envelope, owner, state: recordState, reason }];
      const integrityHash = createHash("sha256").update(JSON.stringify({ records }), "utf8").digest("hex");
      await writeFile(persistencePath, JSON.stringify({ records, integrityHash }), "utf8");

      await expect(new PersistentHandoffService(new FileHandoffPersistence(persistencePath)).ready()).rejects.toThrow(InvalidHandoffError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an invalid lifecycle record at the in-memory persistence save boundary", async () => {
    const persistence = new InMemoryHandoffPersistence();
    const envelope = await service().create({ state: state("chat"), targetEnvironment: "work" });

    await expect(persistence.save([{ envelope, owner: "work", state: "pending", reason: null }])).rejects.toThrow(InvalidHandoffError);
  });

  it("rejects invalid lifecycle records returned by custom persistence during refresh", async () => {
    const envelope = await service().create({ state: state("chat"), targetEnvironment: "work" });
    const persistence = new StaticHandoffPersistence([{ envelope, owner: null, state: "active", reason: null }]);

    await expect(new PersistentHandoffService(persistence).ready()).rejects.toThrow(InvalidHandoffError);
  });

  it("recovers an expired file lock before running a lifecycle operation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const lockPath = `${persistencePath}.lock`;
    try {
      const generationPath = join(lockPath, "1");
      await mkdir(generationPath, { recursive: true });
      await writeFile(join(generationPath, "owner"), "expired-owner", "utf8");
      await writeFile(join(generationPath, "lease"), "expired-owner", "utf8");
      const expiredAt = new Date(Date.now() - FILE_HANDOFF_LOCK_LEASE_MS - 1_000);
      await utimes(join(generationPath, "lease"), expiredAt, expiredAt);

      const handoffService = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      const envelope = await handoffService.create({ state: state("chat"), targetEnvironment: "work" });

      expect(handoffService.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, taskId: envelope.taskId, target: "work", state: "pending", reason: null, owner: null });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not renew its fixed lease while saving", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const lockPath = `${persistencePath}.lock`;
    const persistence = new FileHandoffPersistence(persistencePath);
    try {
      await persistence.withExclusive(async () => {
        const leasePath = join(lockPath, "1", "lease");
        const createdAt = (await stat(leasePath)).mtimeMs;
        await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
        await persistence.save([]);

        expect((await stat(leasePath)).mtimeMs).toBe(createdAt);
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a fixed unexpired lease exclusive during ordinary contention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const persistence = new FileHandoffPersistence(persistencePath);
    const firstLock = { release: null as (() => void) | null };
    const firstStarted = { notify: null as (() => void) | null };
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted.notify = resolve; });
    let secondEntered = false;
    try {
      const first = persistence.withExclusive(async () => {
        firstStarted.notify?.();
        await new Promise<void>((resolve) => { firstLock.release = resolve; });
      });
      await firstStartedPromise;
      const second = persistence.withExclusive(async () => { secondEntered = true; });
      await new Promise<void>((resolve) => { setTimeout(resolve, 20); });

      expect(secondEntered).toBe(false);
      if (firstLock.release === null) throw new Error("The first lock operation did not start");
      firstLock.release();
      await Promise.all([first, second]);
      expect(secondEntered).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("waits for a valid holder released after the former acquisition budget", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const persistence = new FileHandoffPersistence(persistencePath);
    const controls = { holderStarted: null as (() => void) | null, releaseHolder: null as (() => void) | null };
    const holderStarted = new Promise<void>((resolve) => { controls.holderStarted = resolve; });
    const releaseHolder = new Promise<void>((resolve) => { controls.releaseHolder = resolve; });
    let contenderEntered = false;
    try {
      const holder = persistence.withExclusive(async () => {
        controls.holderStarted?.();
        await releaseHolder;
      });
      await holderStarted;
      const contender = persistence.withExclusive(async () => { contenderEntered = true; }).then(
        () => "acquired" as const,
        (error: Error) => error,
      );

      await new Promise<void>((resolve) => { setTimeout(resolve, 4_000); });
      expect(contenderEntered).toBe(false);
      if (controls.releaseHolder === null) throw new Error("The holder lock operation did not start");
      controls.releaseHolder();

      await holder;
      expect(await contender).toBe("acquired");
      expect(contenderEntered).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an expired fixed-lease holder before reclaiming the lock for a successor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const lockPath = `${persistencePath}.lock`;
    const expiredHolderPersistence = new FileHandoffPersistence(persistencePath);
    const successorPersistence = new FileHandoffPersistence(persistencePath);
    const controls = { holderStarted: null as (() => void) | null, refreshExpiredHolder: null as (() => void) | null };
    const holderStarted = new Promise<void>((resolve) => { controls.holderStarted = resolve; });
    const refreshExpiredHolder = new Promise<void>((resolve) => { controls.refreshExpiredHolder = resolve; });
    try {
      const expiredHolder = expiredHolderPersistence.withExclusive(async () => {
        controls.holderStarted?.();
        await refreshExpiredHolder;
        await expiredHolderPersistence.save([]);
      });
      await holderStarted;
      const expiredAt = new Date(Date.now() - FILE_HANDOFF_LOCK_LEASE_MS - 1_000);
      await utimes(join(lockPath, "1", "lease"), expiredAt, expiredAt);
      if (controls.refreshExpiredHolder === null) throw new Error("The expired holder did not start");
      controls.refreshExpiredHolder();

      await expect(expiredHolder).rejects.toThrow(InvalidHandoffError);
      await successorPersistence.withExclusive(async () => {});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prevents a reclaimed lock holder from saving or removing its successor lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const lockPath = `${persistencePath}.lock`;
    const firstPersistence = new FileHandoffPersistence(persistencePath);
    const secondPersistence = new FileHandoffPersistence(persistencePath);
    const controls = { firstStarted: null as (() => void) | null, releaseFirst: null as (() => void) | null, secondStarted: null as (() => void) | null, releaseSecond: null as (() => void) | null };
    const firstStartedPromise = new Promise<void>((resolve) => { controls.firstStarted = resolve; });
    const releaseFirstPromise = new Promise<void>((resolve) => { controls.releaseFirst = resolve; });
    const secondStartedPromise = new Promise<void>((resolve) => { controls.secondStarted = resolve; });
    const releaseSecondPromise = new Promise<void>((resolve) => { controls.releaseSecond = resolve; });
    try {
      const first = firstPersistence.withExclusive(async () => {
        controls.firstStarted?.();
        await releaseFirstPromise;
        await firstPersistence.save([]);
      });
      await firstStartedPromise;
      const expiredAt = new Date(Date.now() - FILE_HANDOFF_LOCK_LEASE_MS - 1_000);
      await utimes(join(lockPath, "1", "lease"), expiredAt, expiredAt);

      const second = secondPersistence.withExclusive(async () => {
        controls.secondStarted?.();
        await releaseSecondPromise;
      });
      await secondStartedPromise;
      if (controls.releaseFirst === null) throw new Error("The first lock operation did not start");
      controls.releaseFirst();

      await expect(first).rejects.toThrow(InvalidHandoffError);
      expect((await stat(lockPath)).isDirectory()).toBe(true);
      if (controls.releaseSecond === null) throw new Error("The successor lock operation did not start");
      controls.releaseSecond();
      await second;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps generation 2 authoritative when generation 1 save resumes after expiry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const lockPath = `${persistencePath}.lock`;
    const envelope = await service().create({ state: state("chat"), targetEnvironment: "work" });
    const newerRecords: readonly HandoffPersistenceRecord[] = [{ envelope, owner: null, state: "pending", reason: null }];
    const successorPersistence = new FileHandoffPersistence(persistencePath);
    const staleHolderPersistence = new FileHandoffPersistence(persistencePath, {
      afterReleaseLockQuarantine: null,
      afterSaveLockOwnershipCheck: async () => {
        const expiredAt = new Date(Date.now() - FILE_HANDOFF_LOCK_LEASE_MS - 1_000);
        await utimes(join(lockPath, "1", "lease"), expiredAt, expiredAt);
        await successorPersistence.withExclusive(async () => {
          await successorPersistence.save(newerRecords);
        });
      },
    });
    try {
      await expect(staleHolderPersistence.withExclusive(async () => {
        await staleHolderPersistence.save([]);
      })).rejects.toThrow(InvalidHandoffError);

      const nextPersistence = new FileHandoffPersistence(persistencePath);
      let loaded: readonly HandoffPersistenceRecord[] = [];
      await nextPersistence.withExclusive(async () => {
        loaded = await nextPersistence.load();
      });
      expect(loaded).toEqual(newerRecords);
      expect((await stat(join(lockPath, "3", "lease"))).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a successor lock intact when stale release resumes after successor acquisition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const lockPath = `${persistencePath}.lock`;
    const controls = { successorStarted: null as (() => void) | null, verifySuccessor: null as (() => void) | null, successorVerified: null as (() => void) | null, releaseSuccessor: null as (() => void) | null };
    const successorStarted = new Promise<void>((resolve) => { controls.successorStarted = resolve; });
    const verifySuccessor = new Promise<void>((resolve) => { controls.verifySuccessor = resolve; });
    const successorVerified = new Promise<void>((resolve) => { controls.successorVerified = resolve; });
    const releaseSuccessor = new Promise<void>((resolve) => { controls.releaseSuccessor = resolve; });
    const successorPersistence = new FileHandoffPersistence(persistencePath);
    let successor: Promise<void> | null = null;
    const staleHolderPersistence = new FileHandoffPersistence(persistencePath, {
      afterReleaseLockQuarantine: async () => {
        const expiredAt = new Date(Date.now() - FILE_HANDOFF_LOCK_LEASE_MS - 1_000);
        await utimes(join(lockPath, "1", "lease"), expiredAt, expiredAt);
        successor = successorPersistence.withExclusive(async () => {
          controls.successorStarted?.();
          await verifySuccessor;
          await successorPersistence.save([]);
          controls.successorVerified?.();
          await releaseSuccessor;
        });
        await successorStarted;
      },
    });
    try {
      await staleHolderPersistence.withExclusive(async () => {});

      if (controls.verifySuccessor === null) throw new Error("The successor lock operation did not start");
      controls.verifySuccessor();
      await successorVerified;
      expect((await stat(join(lockPath, "2", "lease"))).isFile()).toBe(true);
      if (controls.releaseSuccessor === null || successor === null) throw new Error("The successor lock operation was not retained");
      controls.releaseSuccessor();
      await successor;
      await new FileHandoffPersistence(persistencePath).withExclusive(async () => {});
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 1_000);

  it("recovers after release marker publication is interrupted before commit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    const lockPath = `${persistencePath}.lock`;
    let temporaryMarkerObserved = false;
    const interruptedPersistence = new FileHandoffPersistence(persistencePath, {
      afterReleaseLockQuarantine: async () => {
        temporaryMarkerObserved = (await readdir(join(lockPath, "1"))).some((entry) => /^\.released\..+\.tmp$/.test(entry));
        const expiredAt = new Date(Date.now() - FILE_HANDOFF_LOCK_LEASE_MS - 1_000);
        await utimes(join(lockPath, "1", "lease"), expiredAt, expiredAt);
        throw new Error("Simulated interrupted release marker publication");
      },
    });
    try {
      await expect(interruptedPersistence.withExclusive(async () => {})).rejects.toThrow(InvalidHandoffError);
      expect(temporaryMarkerObserved).toBe(true);

      let successorEntered = false;
      await new FileHandoffPersistence(persistencePath).withExclusive(async () => { successorEntered = true; });
      expect(successorEntered).toBe(true);
      expect((await stat(join(lockPath, "2", "released"))).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("wraps file lock preparation failures in InvalidHandoffError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const parentFile = join(directory, "not-a-directory");
    try {
      await writeFile(parentFile, "block lock parent", "utf8");
      const persistence = new FileHandoffPersistence(join(parentFile, "handoffs.json"));

      await expect(persistence.withExclusive(async () => {})).rejects.toThrow(InvalidHandoffError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("exposes restarted adapter status only after adapter ready", async () => {
    const persistence = new InMemoryHandoffPersistence();
    const first = new PersistentHandoffService(persistence);
    const envelope = await first.create({ state: state("chat"), targetEnvironment: "work" });
    const restarted = new WorkEnvironmentAdapter(new PersistentHandoffService(persistence));

    expect(() => restarted.status(envelope.handoffId)).toThrow(InvalidHandoffError);
    await restarted.ready();
    expect(restarted.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, taskId: envelope.taskId, target: "work", state: "pending", reason: null, owner: null });
  });

  it("restarts a file-backed adapter through ready before receive and status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "d-ai-handoff-"));
    const persistencePath = join(directory, "handoffs.json");
    try {
      const first = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      const envelope = await first.create({ state: state("chat"), targetEnvironment: "work" });
      const restartedWork = new WorkEnvironmentAdapter(new PersistentHandoffService(new FileHandoffPersistence(persistencePath)));

      expect(() => restartedWork.status(envelope.handoffId)).toThrow(InvalidHandoffError);
      await restartedWork.ready();
      await restartedWork.receive(envelope);
      expect(restartedWork.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, taskId: envelope.taskId, target: "work", state: "active", reason: null, owner: "work" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
