import { z } from "zod";
import { CapabilityMismatchError, InvalidHandoffError, InvalidTaskStateError } from "../domain/errors.js";
import type { Environment, TaskState } from "../domain/types.js";
import type { EnvironmentCapabilities } from "../routing/environment-capabilities.js";
import { createHandoffEnvelope, handoffEnvelopeSignature, parseHandoffEnvelope, type HandoffEnvelope } from "./envelope.js";

export interface HandoffService {
  create(input: { readonly state: TaskState; readonly targetEnvironment: Environment }): Promise<HandoffEnvelope>;
  acknowledge(envelope: HandoffEnvelope, target: EnvironmentCapabilities): Promise<void>;
  complete(handoffId: string): Promise<void>;
  reject(handoffId: string, reason: string): Promise<void>;
}

export interface HandoffStatus {
  readonly handoffId: string;
  readonly state: "pending" | "active" | "completed" | "rejected";
  readonly reason: string | null;
}

interface HandoffRecord {
  readonly envelope: HandoffEnvelope;
  readonly signature: string;
  readonly owner: Environment | null;
  readonly state: HandoffStatus["state"];
  readonly reason: string | null;
}

const targetSchema = z.object({
  environment: z.enum(["chat", "work", "codex"]),
  capabilities: z.set(z.string()),
}).strict();

function parseTarget(target: EnvironmentCapabilities): EnvironmentCapabilities {
  const result = targetSchema.safeParse(target);
  if (!result.success) {
    const issue = result.error.issues[0];
    const reason = issue === undefined ? "schema validation failed" : `${issue.path.join(".")}: ${issue.message}`;
    throw new CapabilityMismatchError(`Invalid handoff target capabilities: ${reason}`);
  }
  return { environment: result.data.environment, capabilities: new Set(result.data.capabilities) };
}

function requireRecord(records: ReadonlyMap<string, HandoffRecord>, handoffId: string): HandoffRecord {
  const record = records.get(handoffId);
  if (record === undefined) {
    throw new InvalidHandoffError(`Stale or unknown handoff id: ${handoffId}`);
  }
  return record;
}

function validateReason(reason: string): void {
  if (reason.trim().length === 0) {
    throw new InvalidTaskStateError("Handoff rejection reason must be actionable and non-empty");
  }
}

export class InMemoryHandoffService implements HandoffService {
  private readonly records = new Map<string, HandoffRecord>();
  private readonly taskSequences = new Map<string, number>();

  public async create(input: { readonly state: TaskState; readonly targetEnvironment: Environment }): Promise<HandoffEnvelope> {
    const sequence = (this.taskSequences.get(input.state.taskId) ?? 0) + 1;
    const handoffId = `handoff-${input.state.taskId}-${sequence}`;
    const envelope = createHandoffEnvelope({ handoffId, state: input.state, targetEnvironment: input.targetEnvironment });
    if (this.records.has(envelope.handoffId)) {
      throw new InvalidHandoffError(`Duplicate handoff id: ${envelope.handoffId}`);
    }
    this.taskSequences.set(envelope.taskId, sequence);
    const copy = parseHandoffEnvelope(envelope);
    this.records.set(copy.handoffId, { envelope: copy, signature: handoffEnvelopeSignature(copy), owner: null, state: "pending", reason: null });
    return parseHandoffEnvelope(copy);
  }

  public async acknowledge(envelope: HandoffEnvelope, target: EnvironmentCapabilities): Promise<void> {
    const receivedEnvelope = parseHandoffEnvelope(envelope);
    const record = requireRecord(this.records, receivedEnvelope.handoffId);
    if (record.signature !== handoffEnvelopeSignature(receivedEnvelope)) {
      throw new InvalidHandoffError(`Handoff envelope does not match pending handoff: ${receivedEnvelope.handoffId}`);
    }
    const validatedTarget = parseTarget(target);
    if (receivedEnvelope.targetEnvironment !== validatedTarget.environment) {
      throw new InvalidHandoffError(`Handoff ${receivedEnvelope.handoffId} targets ${receivedEnvelope.targetEnvironment}, not ${validatedTarget.environment}`);
    }
    const requiredCapabilities = receivedEnvelope.capabilitySnapshot[validatedTarget.environment];
    if (!requiredCapabilities.every((capability) => validatedTarget.capabilities.has(capability))) {
      throw new CapabilityMismatchError(`Handoff target ${validatedTarget.environment} does not cover required capabilities: ${requiredCapabilities.join(", ")}`);
    }
    if (record.owner !== null || record.state !== "pending") {
      throw new InvalidHandoffError(`Handoff ${receivedEnvelope.handoffId} already has an active owner or terminal state`);
    }
    this.records.set(receivedEnvelope.handoffId, { ...record, owner: validatedTarget.environment, state: "active" });
  }

  public async complete(handoffId: string): Promise<void> {
    const record = requireRecord(this.records, handoffId);
    if (record.state !== "active" || record.owner === null) {
      throw new InvalidTaskStateError(`Handoff ${handoffId} cannot complete from state ${record.state}`);
    }
    this.records.set(handoffId, { ...record, state: "completed", reason: `Completed by ${record.owner}` });
  }

  public async reject(handoffId: string, reason: string): Promise<void> {
    validateReason(reason);
    const record = requireRecord(this.records, handoffId);
    if (record.state === "completed" || record.state === "rejected") {
      throw new InvalidTaskStateError(`Handoff ${handoffId} cannot reject from terminal state ${record.state}`);
    }
    this.records.set(handoffId, { ...record, state: "rejected", reason });
  }

  public status(handoffId: string): HandoffStatus {
    const record = requireRecord(this.records, handoffId);
    return { handoffId, state: record.state, reason: record.reason };
  }
}
