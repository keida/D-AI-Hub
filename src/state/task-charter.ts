import { createHash } from "node:crypto";
import { InvalidTaskStateError } from "../domain/errors.js";
import { z } from "zod";
import type { TaskCharter } from "../domain/types.js";

const charterText = z.string().trim().min(1).max(4096);

export const taskCharterSchema = z.object({
  schemaVersion: z.literal(1),
  charterId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
  charterVersion: z.string().trim().min(1).max(64),
  projectIdentity: z.string().trim().min(1).max(512),
  objective: charterText,
  ownedScope: z.array(charterText).min(1).max(64),
  excludedScope: z.array(charterText).max(64),
  completionCriteria: z.array(charterText).min(1).max(64),
  terminationCondition: charterText,
  initialPhase: charterText.optional(),
  initialNextAction: charterText,
  approval: z.object({
    confirmation: z.literal("I_APPROVE_THIS_TASK_CHARTER"),
    approvedBy: z.string().trim().min(1).max(256),
    approvedAt: z.string().datetime({ offset: true }),
    approvalReference: z.string().trim().min(1).max(512),
    projectIdentity: z.string().trim().min(1).max(512),
    approvedCharterDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
}).strict();

export type ParsedTaskCharter = z.infer<typeof taskCharterSchema>;

export const taskCharterConfirmationEventSchema = z.object({
  confirmationId: z.string().uuid(),
  confirmedAt: z.string().datetime({ offset: true }),
  projectIdentity: z.string().trim().min(1).max(512),
  confirmedCharterDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  channel: z.literal("explicit-task-charter-digest"),
}).strict();

/** Fixed property order and JSON encoding define the approved charter digest. */
export function taskCharterContentDigest(charter: Omit<TaskCharter, "approval"> | ParsedTaskCharter): string {
  const content = {
    schemaVersion: charter.schemaVersion,
    charterId: charter.charterId,
    charterVersion: charter.charterVersion,
    projectIdentity: charter.projectIdentity,
    objective: charter.objective,
    ownedScope: [...charter.ownedScope],
    excludedScope: [...charter.excludedScope],
    completionCriteria: [...charter.completionCriteria],
    terminationCondition: charter.terminationCondition,
    initialPhase: charter.initialPhase ?? null,
    initialNextAction: charter.initialNextAction,
  };
  return createHash("sha256").update(JSON.stringify(content), "utf8").digest("hex");
}

export function parseApprovedTaskCharter(value: unknown): TaskCharter {
  const parsed = taskCharterSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InvalidTaskStateError(`Invalid task charter${issue === undefined ? "" : ` at ${issue.path.join(".")}: ${issue.message}`}`);
  }
  const charter = parsed.data;
  const digest = taskCharterContentDigest(charter);
  if (charter.approval.projectIdentity !== charter.projectIdentity || charter.approval.approvedCharterDigest !== digest) {
    throw new InvalidTaskStateError("Task charter approval does not bind the exact project identity and charter content digest");
  }
  return charter;
}

export function taskCharterTaskId(projectIdentity: string, charterDigest: string): string {
  return `task-${createHash("sha256").update(`dai-successor-v1\n${projectIdentity}\n${charterDigest}`, "utf8").digest("hex").slice(0, 24)}`;
}
