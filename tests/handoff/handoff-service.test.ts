import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { CapabilityMismatchError, InvalidHandoffError, InvalidTaskStateError } from "../../src/domain/errors.js";
import type { Environment, TaskState } from "../../src/domain/types.js";
import { FileHandoffPersistence, InMemoryHandoffPersistence, PersistentHandoffService, type HandoffPersistence, type HandoffPersistenceRecord } from "../../src/handoff/handoff-service.js";
import { validateHandoffCreateInput } from "../../src/handoff/envelope.js";

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

    expect(targetAdapter.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, state: "active", reason: null, owner: target });
  });

  it("redacts every secret-like value, including bearer tokens and nested durable data", async () => {
    const source: TaskState = {
      ...state("codex"), goal: "Authorization: Bearer bearer-secret-value", constraints: ["apiKey=api-secret-value"],
      routingDecision: { stage: "execute", environment: "codex", role: "implementer", selectedModel: "model-secret=router-secret", selectedCapabilities: ["token=capability-secret"], reason: "password=reason-secret", overrideSource: "user" },
      verificationEvidence: [{ evidenceId: "evidence-secret=identifier", stage: "execute", environment: "codex", role: "implementer", selectedModel: "secret=model-secret", command: "Authorization: Bearer command-secret-value", observedOutput: "cookie=output-secret", exitCode: 0, interpretation: "credential: interpretation-secret", passed: true, recoveryPointId: "secret=recovery-id", recordedAt: "2026-08-21T00:00:00.000Z" }],
      recoveryPoint: { recoveryPointId: "secret=recovery-point", taskId: "task-handoff", stage: "execute", environment: "codex", role: "implementer", durablePaths: ["secret=path-secret"], hashes: { secretHash: "hash-secret" }, restorationInstructions: "private_key=restore-secret", createdAt: "2026-08-21T00:00:00.000Z" },
      durableContext: { manifestId: "secret=manifest-id", taskId: "task-handoff", stage: "execute", environment: "codex", role: "implementer", durablePaths: ["token=durable-path-secret"], hashes: { accessToken: "manifest-hash-secret" }, recoveryPointId: "secret=manifest-recovery", recordedAt: "2026-08-21T00:00:00.000Z" },
      criticalUnsavedContext: ["session_token=unsaved-secret"],
    };
    Object.defineProperty(source, "rawTranscript", { value: "private conversation" });
    const envelope = await service().create({ state: source, targetEnvironment: "work" });
    const serialized = JSON.stringify(envelope);
    for (const secret of ["bearer-secret-value", "api-secret-value", "router-secret", "capability-secret", "reason-secret", "command-secret-value", "output-secret", "interpretation-secret", "path-secret", "hash-secret", "restore-secret", "durable-path-secret", "manifest-hash-secret", "unsaved-secret", "private conversation"]) expect(serialized).not.toContain(secret);
    expect(envelope.redactions.length).toBeGreaterThan(10);
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
    await expect(handoffService.create({ state: { ...state("chat"), durableContext: { manifestId: "manifest", taskId: "other-task", stage: "execute", environment: "chat", role: "implementer", durablePaths: [], hashes: {}, recoveryPointId: null, recordedAt: "2026-08-21T00:00:00.000Z" } }, targetEnvironment: "work" })).rejects.toThrow(InvalidHandoffError);
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
    expect(codex.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, state: "completed", reason: "Completed by codex", owner: "codex" });
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
      expect(restarted.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, state: "active", reason: null, owner: "work" });
      await writeFile(persistencePath, (await readFile(persistencePath, "utf8")).replace('"owner":"work"', '"owner":"codex"'), "utf8");
      const tampered = new PersistentHandoffService(new FileHandoffPersistence(persistencePath));
      await expect(tampered.ready()).rejects.toThrow(InvalidHandoffError);
    } finally { await rm(directory, { recursive: true, force: true }); }
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
    expect(work.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, state: "completed", reason: "Completed by work", owner: "work" });
  });

  it("exposes restarted adapter status only after adapter ready", async () => {
    const persistence = new InMemoryHandoffPersistence();
    const first = new PersistentHandoffService(persistence);
    const envelope = await first.create({ state: state("chat"), targetEnvironment: "work" });
    const restarted = new WorkEnvironmentAdapter(new PersistentHandoffService(persistence));

    expect(() => restarted.status(envelope.handoffId)).toThrow(InvalidHandoffError);
    await restarted.ready();
    expect(restarted.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, state: "pending", reason: null, owner: null });
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
      expect(restartedWork.status(envelope.handoffId)).toEqual({ handoffId: envelope.handoffId, state: "active", reason: null, owner: "work" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
