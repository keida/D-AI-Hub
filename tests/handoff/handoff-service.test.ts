import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { CapabilityMismatchError, InvalidHandoffError, InvalidTaskStateError } from "../../src/domain/errors.js";
import type { Environment, TaskState } from "../../src/domain/types.js";
import { FileHandoffPersistence, InMemoryHandoffPersistence, PersistentHandoffService } from "../../src/handoff/handoff-service.js";

function state(environment: Environment): TaskState {
  return { taskId: "task-handoff", goal: "Transfer the portable task state", constraints: ["keep scope narrow"], environment, stage: "execute", role: "implementer", routingDecision: null, selectedCapabilities: [], contextManifest: ["workspace:src"], handoffState: "none", verificationEvidence: [], recoveryPoint: null, approvalState: "approved", criticalUnsavedContext: [], durableContext: null };
}

function service(): PersistentHandoffService { return new PersistentHandoffService(new InMemoryHandoffPersistence()); }

describe("PersistentHandoffService", () => {
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
    const handoffService = service();
    await expect(handoffService.create(null as never)).rejects.toThrow(InvalidTaskStateError);
    await expect(handoffService.create({ state: null as never, targetEnvironment: "work" })).rejects.toThrow(InvalidTaskStateError);
    await expect(handoffService.create({ state: state("chat"), targetEnvironment: null as never })).rejects.toThrow(InvalidTaskStateError);
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
});
