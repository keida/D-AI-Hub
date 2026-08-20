import { describe, expect, it } from "vitest";
import { CodexEnvironmentAdapter } from "../../src/adapters/environments/codex-adapter.js";
import { ChatEnvironmentAdapter } from "../../src/adapters/environments/chat-adapter.js";
import { WorkEnvironmentAdapter } from "../../src/adapters/environments/work-adapter.js";
import { CapabilityMismatchError, InvalidHandoffError, InvalidTaskStateError } from "../../src/domain/errors.js";
import type { Environment, TaskState } from "../../src/domain/types.js";
import { InMemoryHandoffService } from "../../src/handoff/handoff-service.js";

function state(environment: Environment): TaskState {
  return {
    taskId: "task-handoff",
    goal: "Transfer the portable task state",
    constraints: ["keep scope narrow"],
    environment,
    stage: "execute",
    role: "implementer",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: ["workspace:src"],
    handoffState: "none",
    verificationEvidence: [],
    recoveryPoint: null,
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext: null,
  };
}

function adapter(environment: Environment, service: InMemoryHandoffService): ChatEnvironmentAdapter | WorkEnvironmentAdapter | CodexEnvironmentAdapter {
  if (environment === "chat") {
    return new ChatEnvironmentAdapter(service);
  }
  if (environment === "work") {
    return new WorkEnvironmentAdapter(service);
  }
  return new CodexEnvironmentAdapter(service);
}

describe("InMemoryHandoffService", () => {
  it.each<[Environment, Environment]>([
    ["chat", "work"],
    ["work", "codex"],
    ["codex", "work"],
    ["codex", "chat"],
    ["work", "chat"],
    ["chat", "codex"],
  ])("acknowledges the compatible %s to %s handoff exactly once", async (source, target) => {
    const service = new InMemoryHandoffService();
    const envelope = await service.create({ state: state(source), targetEnvironment: target });

    await adapter(target, service).receive(envelope);

    expect(envelope.handoffId).toBe("handoff-task-handoff-1");
    expect(adapter(target, service).status(envelope.handoffId)).toEqual({
      handoffId: envelope.handoffId,
      state: "active",
      reason: null,
    });
  });

  it("returns immutable copies without mutating source state", async () => {
    const service = new InMemoryHandoffService();
    const source = state("chat");
    const envelope = await service.create({ state: source, targetEnvironment: "work" });

    expect(envelope.taskState).not.toBe(source);
    expect(envelope.taskState.constraints).not.toBe(source.constraints);
    expect(envelope.taskState.handoffState).toBe("pending");
    expect(source.handoffState).toBe("none");
    expect(envelope.capabilitySnapshot.work).toEqual(["durable-context"]);
  });

  it("rejects malformed envelopes at acknowledgement", async () => {
    const service = new InMemoryHandoffService();
    const envelope = await service.create({ state: state("chat"), targetEnvironment: "work" });
    Object.defineProperty(envelope, "schemaVersion", { value: 2 });

    await expect(new WorkEnvironmentAdapter(service).receive(envelope)).rejects.toThrow(InvalidHandoffError);
  });

  it("rejects stale, task-mismatched, and source-target-mismatched envelopes", async () => {
    const service = new InMemoryHandoffService();
    const envelope = await service.create({ state: state("chat"), targetEnvironment: "work" });
    const stale = { ...envelope, handoffId: "handoff-task-handoff-99" };
    const taskMismatch = { ...envelope, taskId: "other-task" };
    const sourceMismatch = { ...envelope, sourceEnvironment: "codex" as const };
    const targetMismatch = { ...envelope, targetEnvironment: "codex" as const };
    const work = new WorkEnvironmentAdapter(service);

    await expect(work.receive(stale)).rejects.toThrow(InvalidHandoffError);
    await expect(work.receive(taskMismatch)).rejects.toThrow(InvalidHandoffError);
    await expect(work.receive(sourceMismatch)).rejects.toThrow(InvalidHandoffError);
    await expect(work.receive(targetMismatch)).rejects.toThrow(InvalidHandoffError);
  });

  it("rejects a target that does not cover its capability snapshot", async () => {
    const service = new InMemoryHandoffService();
    const envelope = await service.create({ state: state("chat"), targetEnvironment: "work" });
    const insufficientTarget = { environment: "work" as const, capabilities: new Set<string>() };

    await expect(service.acknowledge(envelope, insufficientTarget)).rejects.toThrow(CapabilityMismatchError);
  });

  it("rejects duplicate ownership and terminal-state rewrites", async () => {
    const service = new InMemoryHandoffService();
    const envelope = await service.create({ state: state("work"), targetEnvironment: "codex" });
    const codex = new CodexEnvironmentAdapter(service);

    await codex.receive(envelope);
    await expect(codex.receive(envelope)).rejects.toThrow(InvalidHandoffError);
    await service.complete(envelope.handoffId);
    await expect(service.complete(envelope.handoffId)).rejects.toThrow(InvalidTaskStateError);
    await expect(service.reject(envelope.handoffId, "retry later")).rejects.toThrow(InvalidTaskStateError);
  });

  it("records actionable rejection reasons and rejects repeated rejection", async () => {
    const service = new InMemoryHandoffService();
    const envelope = await service.create({ state: state("codex"), targetEnvironment: "chat" });

    await service.reject(envelope.handoffId, "Approval context is incomplete");

    expect(new ChatEnvironmentAdapter(service).status(envelope.handoffId)).toEqual({
      handoffId: envelope.handoffId,
      state: "rejected",
      reason: "Approval context is incomplete",
    });
    await expect(service.reject(envelope.handoffId, "another reason")).rejects.toThrow(InvalidTaskStateError);
  });

  it("redacts secret-like values, excludes raw transcripts, and preserves unsaved context", async () => {
    const service = new InMemoryHandoffService();
    const source = state("codex");
    const withSensitiveContext = {
      ...source,
      constraints: ["apiKey=super-secret", "keep this migration"],
      criticalUnsavedContext: ["uncommitted migration"],
    };
    Object.defineProperty(withSensitiveContext, "rawTranscript", { value: "private conversation" });

    const envelope = await service.create({ state: withSensitiveContext, targetEnvironment: "work" });

    expect(envelope.taskState.constraints).toEqual(["apiKey=[REDACTED]", "keep this migration"]);
    expect(envelope.unsavedContext).toEqual(["uncommitted migration"]);
    expect(envelope.redactions).toContain("taskState.constraints[0]");
    expect(JSON.stringify(envelope)).not.toContain("super-secret");
    expect(JSON.stringify(envelope)).not.toContain("private conversation");
    expect(source.constraints).toEqual(["keep scope narrow"]);
  });

  it("validates task state before creating a pending owner", async () => {
    const service = new InMemoryHandoffService();
    const invalid = state("chat");
    Object.defineProperty(invalid, "taskId", { value: "" });

    await expect(service.create({ state: invalid, targetEnvironment: "work" })).rejects.toThrow(InvalidTaskStateError);
  });
});

describe("environment adapters", () => {
  it.each([
    ["chat", ["approval", "status"]],
    ["work", ["durable-context"]],
    ["codex", ["local-execution", "codex-evidence"]],
  ] as const)("declares only %s capabilities", (environment, expectedCapabilities) => {
    const service = new InMemoryHandoffService();

    expect([...adapter(environment, service).capabilities().capabilities]).toEqual(expectedCapabilities);
  });

  it("keeps adapter receive boundaries environment-specific", async () => {
    const service = new InMemoryHandoffService();
    const envelope = await service.create({ state: state("chat"), targetEnvironment: "work" });

    await expect(new CodexEnvironmentAdapter(service).receive(envelope)).rejects.toThrow(InvalidHandoffError);
  });
});
