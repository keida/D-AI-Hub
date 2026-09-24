import { createHash, randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

export type ProjectOwnedEvidenceReference =
  | {
      readonly id: string;
      readonly kind: "git-blob";
      readonly repositoryIdentity: string;
      readonly commitSha: string;
      readonly path: string;
      readonly blobOid: string;
      readonly sha256: string;
    }
  | {
      readonly id: string;
      readonly kind: "https-object";
      readonly url: string;
      readonly immutableId: string;
      readonly sha256: string;
    };

export interface HumanConfirmationBinding {
  readonly project: {
    readonly identity: string;
    readonly workId: string;
    readonly executionOwnerId: string;
  };
  readonly dai: { readonly taskId: string };
  readonly result: { readonly resultId: string; readonly contract: "dai.project-result"; readonly schemaVersion: 1 };
  readonly artifact: {
    readonly repositoryIdentity: string;
    readonly canonicalPath: string;
    readonly publicationCommitSha: string;
    readonly gitBlobOid: string;
    readonly sha256: string;
  };
  readonly evidenceRefs: readonly ProjectOwnedEvidenceReference[];
}

const objectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const nonemptySchema = z.string().trim().min(1).max(512);
const evidenceRefSchema = z.discriminatedUnion("kind", [
  z.object({
    id: nonemptySchema,
    kind: z.literal("git-blob"),
    repositoryIdentity: nonemptySchema,
    commitSha: objectIdSchema,
    path: nonemptySchema,
    blobOid: objectIdSchema,
    sha256: digestSchema,
  }).strict(),
  z.object({
    id: nonemptySchema,
    kind: z.literal("https-object"),
    url: z.string().url().startsWith("https://"),
    immutableId: nonemptySchema,
    sha256: digestSchema,
  }).strict(),
]);
const bindingSchema = z.object({
  project: z.object({ identity: nonemptySchema, workId: nonemptySchema, executionOwnerId: nonemptySchema }).strict(),
  dai: z.object({ taskId: z.string().regex(/^task-[A-Za-z0-9._-]+$/u) }).strict(),
  result: z.object({ resultId: nonemptySchema, contract: z.literal("dai.project-result"), schemaVersion: z.literal(1) }).strict(),
  artifact: z.object({
    repositoryIdentity: nonemptySchema,
    canonicalPath: nonemptySchema,
    publicationCommitSha: objectIdSchema,
    gitBlobOid: objectIdSchema,
    sha256: digestSchema,
  }).strict(),
  evidenceRefs: z.array(evidenceRefSchema).min(1),
}).strict();

export const humanConfirmationEventSchema = z.object({
  contract: z.literal("dai.project-result-confirmation"),
  schemaVersion: z.literal(1),
  eventId: z.string().uuid(),
  authorityState: z.literal("HUMAN-CONFIRMED"),
  intent: z.literal("RECONCILE_PROJECT_OWNED_RESULT"),
  project: bindingSchema.shape.project,
  dai: bindingSchema.shape.dai,
  result: bindingSchema.shape.result,
  artifact: bindingSchema.shape.artifact,
  evidenceRefs: bindingSchema.shape.evidenceRefs,
  confirmedAt: z.string().datetime(),
  operatorContext: z.object({
    host: z.literal("local"),
    sessionId: nonemptySchema,
    interactionId: nonemptySchema,
  }).strict(),
}).strict();

export type HumanConfirmationEvent = z.infer<typeof humanConfirmationEventSchema>;

export type AuthorityMode = "UNVERIFIED" | "HUMAN-CONFIRMED" | "HOST-ATTESTED";

export interface AuthorityVerifier<TMode extends AuthorityMode, TResult> {
  readonly mode: TMode;
  capture(binding: HumanConfirmationBinding): Promise<TResult>;
}

export interface OperatorInteraction {
  confirm(binding: HumanConfirmationBinding, challenge: string): Promise<boolean>;
}

export class TerminalOperatorInteraction implements OperatorInteraction {
  public constructor(
    private readonly input: Readable & { readonly isTTY?: boolean } = process.stdin,
    private readonly output: Writable & { readonly isTTY?: boolean } = process.stdout,
  ) {}

  public async confirm(binding: HumanConfirmationBinding, challenge: string): Promise<boolean> {
    if (this.input.isTTY !== true || this.output.isTTY !== true) {
      throw new Error("HUMAN-CONFIRMED requires an interactive local terminal; no request field can substitute for operator input");
    }
    this.output.write(`Review the exact immutable project result binding:\n${JSON.stringify(binding, null, 2)}\n`);
    const readline = createInterface({ input: this.input, output: this.output, terminal: true });
    try {
      const response = await readline.question(`To authorize consideration for reconciliation, type HUMAN-CONFIRM ${challenge}: `);
      return response.trim() === `HUMAN-CONFIRM ${challenge}`;
    } finally {
      readline.close();
    }
  }
}

export class HumanConfirmationVerifier implements AuthorityVerifier<"HUMAN-CONFIRMED", HumanConfirmationEvent> {
  public readonly mode = "HUMAN-CONFIRMED" as const;

  public constructor(
    private readonly interaction: OperatorInteraction = new TerminalOperatorInteraction(),
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  public async capture(bindingInput: HumanConfirmationBinding): Promise<HumanConfirmationEvent> {
    const bindingResult = bindingSchema.safeParse(bindingInput);
    if (!bindingResult.success) throw new Error("Human confirmation binding is malformed");
    const binding = bindingResult.data;
    const eventId = this.createId();
    const canonicalBinding = canonicalize(binding);
    const challenge = createHash("sha256").update(`${eventId}\0${canonicalBinding}`, "utf8").digest("hex").slice(0, 12).toUpperCase();
    // This is local single-operator intent, not authentication of the project's Boss or publisher.
    if (!await this.interaction.confirm(binding, challenge)) throw new Error("The local operator did not confirm this exact project result");
    const confirmedAt = this.now().toISOString();
    const event = humanConfirmationEventSchema.parse({
      contract: "dai.project-result-confirmation",
      schemaVersion: 1,
      eventId,
      authorityState: "HUMAN-CONFIRMED",
      intent: "RECONCILE_PROJECT_OWNED_RESULT",
      ...binding,
      confirmedAt,
      operatorContext: { host: "local", sessionId: `pid:${process.pid}`, interactionId: this.createId() },
    });
    return event;
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize a human confirmation binding");
  return serialized;
}
