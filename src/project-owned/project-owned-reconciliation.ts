import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import { CommandExecutionError, redactSensitiveText, runCommand } from "../adapters/command-runner.js";
import { resolveGitEndpoint, resolveGitRepositoryRoot } from "../adapters/git.js";
import { resolveGitHubRepository } from "../adapters/github.js";
import { InvalidTaskStateError } from "../domain/errors.js";
import { containsSecretShapedValue } from "../domain/manifest-id.js";
import { isDurableTaskId } from "../domain/task-id.js";
import type { Stage, TaskState } from "../domain/types.js";
import { matchesWorkspaceIdentity } from "../state/workspace-identity.js";
import type { DurableContextStore } from "../state/durable-context-store.js";
import { HumanConfirmationVerifier, humanConfirmationEventSchema, type HumanConfirmationBinding, type HumanConfirmationEvent, type ProjectOwnedEvidenceReference } from "./authority-verifier.js";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const objectIdSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu);
const nonemptySchema = z.string().trim().min(1).max(512);
const taskIdSchema = z.string().refine(isDurableTaskId);
const scopeSchema = z.array(nonemptySchema).min(1).refine((values) => new Set(values).size === values.length);
const execFileBuffer = promisify(execFile);

const resultEvidenceRefSchema = z.discriminatedUnion("kind", [
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

const verificationSchema = z.object({
  check: nonemptySchema,
  verdict: z.enum(["PASS", "FAIL", "BLOCKED"]),
  checkedAt: z.string().datetime(),
  evidenceRefId: nonemptySchema,
}).strict();

const projectOwnedResultSchema = z.object({
  contract: z.literal("dai.project-result"),
  schemaVersion: z.literal(1),
  resultId: nonemptySchema,
  supersedesResultId: nonemptySchema.optional(),
  project: z.object({
    identity: nonemptySchema,
    workId: nonemptySchema,
    executionOwnerId: nonemptySchema,
  }).strict(),
  dai: z.object({ taskId: z.string().regex(/^task-[A-Za-z0-9._-]+$/u) }).strict(),
  execution: z.object({
    verdict: z.enum(["PASS", "FAIL", "BLOCKED"]),
    scope: scopeSchema,
    observedAt: z.string().datetime().optional(),
  }).strict(),
  acceptance: z.object({
    verdict: z.enum(["ACCEPTED", "REJECTED"]),
    authorityId: nonemptySchema,
    acceptedScope: scopeSchema,
    acceptedAt: z.string().datetime(),
  }).strict(),
  evidence: z.object({
    profile: z.literal("skill-pulse.sp-ops-006/v1"),
    refs: z.array(resultEvidenceRefSchema).min(1),
    case: z.object({
      naturalSchedulerInstanceId: nonemptySchema,
      schedulerEvents: z.array(z.object({
        eventId: z.number().int().nonnegative(),
        recordId: z.number().int().nonnegative(),
        evidenceRefId: nonemptySchema,
      }).strict()).min(1),
      runtimeLogSha256: digestSchema,
      runtimeLogEvidenceRefId: nonemptySchema,
      snapshot: z.object({
        commitSha: objectIdSchema,
        gitBlobOid: objectIdSchema,
        gitBlobSha256: digestSchema,
        evidenceRefId: nonemptySchema,
      }).strict(),
      netlify: z.object({
        deployId: nonemptySchema,
        immutableManifestUrl: z.string().url().startsWith("https://"),
        immutableManifestVerification: verificationSchema.extend({ check: z.literal("immutable-deploy-manifest") }).strict(),
        productionAliasVerification: verificationSchema.extend({ check: z.literal("production-alias") }).strict(),
      }).strict(),
    }).strict(),
  }).strict(),
}).strict();

type ProjectOwnedResult = z.infer<typeof projectOwnedResultSchema>;

export interface ProjectOwnedResultSource {
  readonly repositoryPath: string;
  readonly commitSha: string;
  readonly artifactPath: string;
  readonly blobOid: string;
  readonly sha256: string;
}

export interface ProjectOwnedResultPolicy {
  readonly taskId: string;
  readonly projectIdentity: string;
  readonly workId: string;
  readonly executionOwnerId: string;
  readonly workspacePath: string;
  readonly repositoryPath: string;
  readonly canonicalArtifactPath: string;
  readonly publicationRemote: string;
  readonly publicationRef: string;
  readonly githubEnterpriseHost?: string | null;
}

export type ProjectResultDisposition =
  | "HANDOFF_VERIFIED_AWAITING_CLOSE_DECISION"
  | "PROJECT_EXECUTION_FAILED"
  | "PROJECT_EXECUTION_BLOCKED"
  | "PROJECT_RESULT_REJECTED";

export type ProjectOwnedVerificationLimitation =
  | "ACCEPTANCE_SCOPE_SEMANTICS_NOT_MACHINE_PROVEN"
  | "NETLIFY_MANIFEST_URL_BYTES_NOT_REFETCHED"
  | "NETLIFY_PRODUCTION_ALIAS_NOT_RECHECKED";

export interface ProjectOwnedReconciliationAudit {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly projectIdentity: string;
  readonly workId: string;
  readonly executionOwnerId: string;
  readonly authorityMode: "HUMAN-CONFIRMED";
  readonly confirmationConsumed: true;
  readonly confirmation: HumanConfirmationEvent;
  readonly source: ProjectOwnedResultSource;
  readonly publicationRef: string;
  readonly publicationRefTip: string;
  readonly publicationObservedAt: string;
  readonly result: {
    readonly resultId: string;
    readonly contract: "dai.project-result";
    readonly schemaVersion: 1;
    readonly executionVerdict: ProjectOwnedResult["execution"]["verdict"];
    readonly executionScope: readonly string[];
    readonly acceptanceVerdict: ProjectOwnedResult["acceptance"]["verdict"];
    readonly acceptedScope: readonly string[];
    readonly evidenceProfile: "skill-pulse.sp-ops-006/v1";
    readonly evidenceRefs: readonly ProjectOwnedEvidenceReference[];
  };
  readonly priorStage: "route";
  readonly taskSnapshotSha256: string;
  readonly reconciliationStatus: "VERIFIED_WITH_LIMITATIONS";
  readonly verificationLimitations: readonly ProjectOwnedVerificationLimitation[];
  readonly projectResultDisposition: ProjectResultDisposition;
  readonly recordedAt: string;
}

const sourceSchema = z.object({
  repositoryPath: z.string().trim().min(1),
  commitSha: objectIdSchema,
  artifactPath: z.string().trim().min(1).max(512),
  blobOid: objectIdSchema,
  sha256: digestSchema,
}).strict();

const requestSchema = z.object({
  taskId: taskIdSchema,
  source: sourceSchema,
  replayEventId: z.string().uuid().optional(),
}).strict();

const auditSchema = z.object({
  schemaVersion: z.literal(1),
  taskId: taskIdSchema,
  projectIdentity: nonemptySchema,
  workId: nonemptySchema,
  executionOwnerId: nonemptySchema,
  authorityMode: z.literal("HUMAN-CONFIRMED"),
  confirmationConsumed: z.literal(true),
  confirmation: humanConfirmationEventSchema,
  source: sourceSchema,
  publicationRef: nonemptySchema,
  publicationRefTip: objectIdSchema,
  publicationObservedAt: z.string().datetime(),
  result: z.object({
    resultId: nonemptySchema,
    contract: z.literal("dai.project-result"),
    schemaVersion: z.literal(1),
    executionVerdict: z.enum(["PASS", "FAIL", "BLOCKED"]),
    executionScope: scopeSchema,
    acceptanceVerdict: z.enum(["ACCEPTED", "REJECTED"]),
    acceptedScope: scopeSchema,
    evidenceProfile: z.literal("skill-pulse.sp-ops-006/v1"),
    evidenceRefs: z.array(resultEvidenceRefSchema).min(1),
  }).strict(),
  priorStage: z.literal("route"),
  taskSnapshotSha256: digestSchema,
  reconciliationStatus: z.literal("VERIFIED_WITH_LIMITATIONS"),
  verificationLimitations: z.array(z.enum([
    "ACCEPTANCE_SCOPE_SEMANTICS_NOT_MACHINE_PROVEN",
    "NETLIFY_MANIFEST_URL_BYTES_NOT_REFETCHED",
    "NETLIFY_PRODUCTION_ALIAS_NOT_RECHECKED",
  ])).min(1),
  projectResultDisposition: z.enum([
    "HANDOFF_VERIFIED_AWAITING_CLOSE_DECISION",
    "PROJECT_EXECUTION_FAILED",
    "PROJECT_EXECUTION_BLOCKED",
    "PROJECT_RESULT_REJECTED",
  ]),
  recordedAt: z.string().datetime(),
}).strict();

const auditEnvelopeSchema = z.object({
  audit: auditSchema,
  auditSha256: digestSchema,
}).strict();

// This checksum detects accidental corruption only. It is not authenticated storage and cannot resist a local writer who can rewrite both fields.

export type ProjectOwnedReconciliationResponse =
  | { readonly status: "reconciled"; readonly taskId: string; readonly taskStage: "route"; readonly audit: ProjectOwnedReconciliationAudit; readonly replayed: boolean; readonly message: string }
  | { readonly status: "blocked"; readonly taskId: string; readonly taskStage: Stage | "bootstrap"; readonly message: string };

export interface ProjectOwnedRecovery {
  readonly task: TaskState;
  readonly projectOwnedReconciliations: readonly ProjectOwnedReconciliationAudit[];
}

interface VerifiedArtifact {
  readonly result: ProjectOwnedResult;
  readonly source: ProjectOwnedResultSource;
  readonly binding: HumanConfirmationBinding;
  readonly repositoryRoot: string;
  readonly publicationRefTip: string;
}

export interface ProjectOwnedReconciliationOptions {
  readonly store: DurableContextStore;
  readonly auditRoot?: string;
  readonly policy: ProjectOwnedResultPolicy;
  readonly now?: () => Date;
}

export class ProjectOwnedReconciliationService {
  private readonly store: DurableContextStore;
  private readonly auditRoot: string;
  private readonly usesDefaultAuditRoot: boolean;
  private readonly policy: ProjectOwnedResultPolicy;
  // The service owns its confirmation mechanism: only local TTY input can create accepted intent.
  private readonly authorityVerifier = new HumanConfirmationVerifier();
  private readonly now: () => Date;

  public constructor(options: ProjectOwnedReconciliationOptions) {
    this.store = options.store;
    this.usesDefaultAuditRoot = options.auditRoot === undefined;
    this.auditRoot = resolve(options.auditRoot ?? defaultProjectOwnedAuditRoot());
    this.policy = options.policy;
    this.now = options.now ?? (() => new Date());
  }

  public async reconcile(requestInput: unknown): Promise<ProjectOwnedReconciliationResponse> {
    const parsedRequest = requestSchema.safeParse(requestInput);
    const taskId = typeof requestInput === "object" && requestInput !== null && "taskId" in requestInput && typeof requestInput.taskId === "string"
      ? requestInput.taskId
      : this.policy.taskId;
    if (!parsedRequest.success) return this.blocked(taskId, "Project-owned reconciliation request is malformed");
    const request = parsedRequest.data;
    if (request.taskId !== this.policy.taskId) return this.blocked(request.taskId, "Request task does not match the configured project-owned result policy");
    if (this.store.withTaskOwnership === undefined) return this.blocked(request.taskId, "Project-owned reconciliation requires durable task ownership support");

    try {
      const initialState = await this.loadEligibleTask(request.taskId);
      const verified = await this.verifyResult(initialState, request.source);
      const initialSnapshot = taskSnapshotDigest(initialState);
      const existingAudits = await this.readAudits(request.taskId);
      const exactExisting = existingAudits.find((audit) => sameBinding(audit.confirmation, verified.binding));
      if (request.replayEventId !== undefined) {
        const replay = existingAudits.find((audit) => audit.confirmation.eventId === request.replayEventId);
        if (replay === undefined || !sameBinding(replay.confirmation, verified.binding)) {
          return this.blocked(request.taskId, "Replay event is missing or conflicts with the exact project result binding");
        }
        return this.accepted(replay, true);
      }
      if (exactExisting !== undefined) return this.accepted(exactExisting, true);
      if (existingAudits.length > 0) return this.blocked(request.taskId, "A different immutable project result is already recorded for this task");

      if (this.authorityVerifier.mode !== "HUMAN-CONFIRMED") return this.blocked(request.taskId, "This reconciliation service supports only the HUMAN-CONFIRMED authority mode");
      const capturedConfirmation = await this.authorityVerifier.capture(verified.binding);
      const confirmationResult = humanConfirmationEventSchema.safeParse(capturedConfirmation);
      if (!confirmationResult.success) return this.blocked(request.taskId, "Authority verifier returned an unsupported or malformed confirmation mode");
      const confirmation = confirmationResult.data;
      if (!sameBinding(confirmation, verified.binding)) return this.blocked(request.taskId, "Human confirmation does not match the verified immutable result binding");
      const audit = createAudit(this.policy, verified, confirmation, "route", initialSnapshot, verified.publicationRefTip, this.now());

      let outcome: ProjectOwnedReconciliationResponse | null = null;
      await this.store.withTaskOwnership(request.taskId, initialState.environment, async (_lease, _transfer, assertOwnership) => {
        await assertOwnership();
        const current = await this.store.load(request.taskId);
        if (current === null || current.stage !== "route" || taskSnapshotDigest(current) !== initialSnapshot) {
          outcome = this.blocked(request.taskId, "Task state changed during confirmation; the captured event was not consumed");
          return;
        }
        const currentPublicationTip = await verifyPublishedCommit(verified.repositoryRoot, this.policy.publicationRemote, this.policy.publicationRef, request.source.commitSha);
        if (!sameIdentity(currentPublicationTip, verified.publicationRefTip)) {
          outcome = this.blocked(request.taskId, "Canonical publication ref moved during operator confirmation; reconciliation was not recorded");
          return;
        }
        const currentAudits = await this.readAudits(request.taskId);
        const replayNow = currentAudits.find((entry) => entry.confirmation.eventId === confirmation.eventId);
        if (replayNow !== undefined) {
          outcome = sameAuditPayload(replayNow, audit)
            ? this.accepted(replayNow, true)
            : this.blocked(request.taskId, "Confirmation event ID is already bound to a different payload");
          return;
        }
        if (currentAudits.length > 0) {
          outcome = this.blocked(request.taskId, "A conflicting project-owned reconciliation is already recorded for this task");
          return;
        }
        await assertOwnership();
        await this.writeAudit(audit);
        await assertOwnership();
        outcome = this.accepted(audit, false);
      });
      return outcome ?? this.blocked(request.taskId, "Durable task ownership ended before reconciliation was recorded");
    } catch (error: unknown) {
      return this.blocked(request.taskId, error instanceof Error ? redactSensitiveText(error.message) : "Project-owned reconciliation failed closed");
    }
  }

  public async recover(taskId: string): Promise<ProjectOwnedRecovery | null> {
    if (taskId !== this.policy.taskId || !isDurableTaskId(taskId)) return null;
    const task = await this.store.load(taskId);
    if (task === null || task.environment !== "codex" || !await this.matchesConfiguredTask(task)) return null;
    return { task, projectOwnedReconciliations: await this.readAudits(taskId) };
  }

  private async loadEligibleTask(taskId: string): Promise<TaskState> {
    const state = await this.store.load(taskId);
    if (state === null) throw new InvalidTaskStateError("Durable task is unavailable");
    if (!await this.matchesConfiguredTask(state)) throw new InvalidTaskStateError("Durable task does not match the configured workspace and canonical project identity");
    if (state.environment !== "codex" || state.stage !== "route") throw new InvalidTaskStateError("Project-owned reconciliation only records an eligible Codex task at its true route stage");
    return state;
  }

  private async matchesConfiguredTask(state: TaskState): Promise<boolean> {
    const remoteEntry = `remote-repository:${this.policy.projectIdentity}`;
    return state.taskId === this.policy.taskId
      && state.contextManifest.filter((entry) => entry === remoteEntry).length === 1
      && await matchesWorkspaceIdentity(state.contextManifest, this.policy.workspacePath);
  }

  private async verifyResult(state: TaskState, sourceInput: ProjectOwnedResultSource): Promise<VerifiedArtifact> {
    const source = sourceSchema.parse(sourceInput);
    if (source.artifactPath !== this.policy.canonicalArtifactPath) throw new InvalidTaskStateError("Result path is not the configured project-owned canonical path");
    const repositoryRoot = await resolveGitRepositoryRoot(this.policy.repositoryPath);
    const suppliedRoot = await resolveGitRepositoryRoot(source.repositoryPath);
    if (repositoryRoot !== suppliedRoot) throw new InvalidTaskStateError("Result source repository does not match the configured workspace repository");
    const originUrls = await gitConfigValues(repositoryRoot, `remote.${this.policy.publicationRemote}.url`);
    if (originUrls.length !== 1 || originUrls[0] === undefined) throw new InvalidTaskStateError("Publication remote must have exactly one configured URL");
    const configuredIdentity = resolveGitHubRepository(originUrls[0], this.policy.githubEnterpriseHost ?? null).repository;
    const effectiveEndpoint = await resolveGitEndpoint(repositoryRoot, originUrls[0]);
    const effectiveIdentity = resolveGitHubRepository(effectiveEndpoint, this.policy.githubEnterpriseHost ?? null).repository;
    if (!sameIdentity(configuredIdentity, this.policy.projectIdentity) || !sameIdentity(effectiveIdentity, this.policy.projectIdentity)) {
      throw new InvalidTaskStateError("Configured and effective publication repository identities do not match the project policy");
    }
    const pushUrls = await gitConfigValues(repositoryRoot, `remote.${this.policy.publicationRemote}.pushurl`);
    if (pushUrls.length > 1) throw new InvalidTaskStateError("Publication remote has multiple push URLs");
    if (pushUrls[0] !== undefined) {
      const pushEndpoint = await resolveGitEndpoint(repositoryRoot, pushUrls[0]);
      const pushIdentity = resolveGitHubRepository(pushEndpoint, this.policy.githubEnterpriseHost ?? null).repository;
      if (!sameIdentity(pushIdentity, configuredIdentity)) throw new InvalidTaskStateError("Effective push repository does not match the canonical project repository");
    }

    const commitSha = await gitOutput(repositoryRoot, ["rev-parse", "--verify", `${source.commitSha}^{commit}`], "resolve immutable result commit");
    if (!sameIdentity(commitSha, source.commitSha)) throw new InvalidTaskStateError("Result commit did not resolve to the requested immutable object");
    const blobOid = await gitOutput(repositoryRoot, ["rev-parse", "--verify", `${source.commitSha}:${source.artifactPath}`], "resolve result artifact blob");
    if (!sameIdentity(blobOid, source.blobOid)) throw new InvalidTaskStateError("Result blob OID does not match the immutable source");
    const artifactBytes = await gitContent(repositoryRoot, ["show", `${source.commitSha}:${source.artifactPath}`], "read immutable result artifact");
    if (sha256(artifactBytes) !== source.sha256.toLowerCase()) throw new InvalidTaskStateError("Result artifact SHA-256 does not match the immutable source");
    const result = projectOwnedResultSchema.parse(JSON.parse(artifactBytes.toString("utf8"))) as ProjectOwnedResult;
    if (result.evidence.profile !== "skill-pulse.sp-ops-006/v1") throw new InvalidTaskStateError("This verifier supports only the contracted skill-pulse.sp-ops-006/v1 profile");
    if (result.project.identity !== this.policy.projectIdentity
      || result.project.workId !== this.policy.workId
      || result.project.executionOwnerId !== this.policy.executionOwnerId
      || result.dai.taskId !== state.taskId) {
      throw new InvalidTaskStateError("Project result identity does not match the configured project and durable task");
    }
    if (result.project.identity !== configuredIdentity || result.project.identity !== effectiveIdentity) {
      throw new InvalidTaskStateError("Project result identity does not match the canonical publication repository");
    }
    const publicationRefTip = await verifyPublishedCommit(repositoryRoot, this.policy.publicationRemote, this.policy.publicationRef, source.commitSha);
    await verifyProfileEvidence(result, repositoryRoot, this.policy);
    return {
      result,
      source,
      repositoryRoot,
      publicationRefTip,
      binding: {
        project: result.project,
        dai: result.dai,
        result: { resultId: result.resultId, contract: result.contract, schemaVersion: result.schemaVersion },
        artifact: {
          repositoryIdentity: result.project.identity,
          canonicalPath: source.artifactPath,
          publicationCommitSha: source.commitSha,
          gitBlobOid: source.blobOid,
          sha256: source.sha256.toLowerCase(),
        },
        evidenceRefs: result.evidence.refs,
      },
    };
  }

  private async readAudits(taskId: string): Promise<readonly ProjectOwnedReconciliationAudit[]> {
    const directory = taskAuditDirectory(this.auditRoot, taskId);
    let entries: string[];
    try {
      await assertPrivateDirectory(directory, this.auditRoot);
      entries = await readdir(directory);
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
    const audits: ProjectOwnedReconciliationAudit[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
      if (!/^[0-9a-f-]{36}\.json$/iu.test(entry)) throw new InvalidTaskStateError("Project-owned audit directory contains an invalid event filename");
      const value = JSON.parse(await readFile(join(directory, entry), "utf8")) as unknown;
      const envelope = auditEnvelopeSchema.parse(value);
      const observedHash = sha256(canonicalJson(envelope.audit));
      if (observedHash !== envelope.auditSha256 || envelope.audit.taskId !== taskId || basename(entry) !== `${envelope.audit.confirmation.eventId}.json`
        || !auditMatchesPolicy(envelope.audit, this.policy)) {
        throw new InvalidTaskStateError("Project-owned reconciliation audit checksum or policy-binding check failed");
      }
      if (containsSecretShapedValue(canonicalJson(envelope.audit))) throw new InvalidTaskStateError("Project-owned reconciliation audit contains credential-like data");
      audits.push(envelope.audit);
    }
    return audits;
  }

  private async writeAudit(audit: ProjectOwnedReconciliationAudit): Promise<void> {
    const parsed = auditSchema.parse(audit);
    if (containsSecretShapedValue(canonicalJson(parsed))) throw new InvalidTaskStateError("Project-owned reconciliation audit contains credential-like data");
    const directory = taskAuditDirectory(this.auditRoot, audit.taskId);
    await this.ensureAuditRoot();
    await assertPrivateDirectory(this.auditRoot);
    await mkdir(join(this.auditRoot, audit.taskId), { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(join(this.auditRoot, audit.taskId), this.auditRoot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(directory, this.auditRoot);
    const target = join(directory, `${audit.confirmation.eventId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const envelope = { audit: parsed, auditSha256: sha256(canonicalJson(parsed)) };
    try {
      await writeFile(temporary, `${canonicalJson(envelope)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporary, target);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async ensureAuditRoot(): Promise<void> {
    if (!this.usesDefaultAuditRoot) {
      await mkdir(this.auditRoot, { recursive: true, mode: 0o700 });
      return;
    }
    let created = false;
    try {
      await mkdir(this.auditRoot, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) throw error;
    }
    if (created && process.platform === "win32") hardenNewWindowsAuditRoot(this.auditRoot);
  }

  private accepted(audit: ProjectOwnedReconciliationAudit, replayed: boolean): ProjectOwnedReconciliationResponse {
    return {
      status: "reconciled",
      taskId: audit.taskId,
      taskStage: "route",
      audit,
      replayed,
      message: `Project-owned result reconciliation was verified with recorded limitations; D-AI task remains at route and close remains a separate decision (${audit.projectResultDisposition})`,
    };
  }

  private blocked(taskId: string, message: string): ProjectOwnedReconciliationResponse {
    return { status: "blocked", taskId, taskStage: "bootstrap", message: redactSensitiveText(message) };
  }
}

export function deriveProjectResultDisposition(result: Pick<ProjectOwnedResult, "execution" | "acceptance">): ProjectResultDisposition {
  return result.execution.verdict === "BLOCKED"
    ? "PROJECT_EXECUTION_BLOCKED"
    : result.execution.verdict === "FAIL"
      ? "PROJECT_EXECUTION_FAILED"
      : result.acceptance.verdict === "REJECTED"
        ? "PROJECT_RESULT_REJECTED"
        : "HANDOFF_VERIFIED_AWAITING_CLOSE_DECISION";
}

function createAudit(
  policy: ProjectOwnedResultPolicy,
  verified: VerifiedArtifact,
  confirmation: HumanConfirmationEvent,
  priorStage: "route",
  taskSnapshotSha256: string,
  publicationRefTip: string,
  now: Date,
): ProjectOwnedReconciliationAudit {
  const result = verified.result;
  const projectResultDisposition = deriveProjectResultDisposition(result);
  return {
    schemaVersion: 1,
    taskId: policy.taskId,
    projectIdentity: policy.projectIdentity,
    workId: policy.workId,
    executionOwnerId: policy.executionOwnerId,
    authorityMode: "HUMAN-CONFIRMED",
    confirmationConsumed: true,
    confirmation,
    source: verified.source,
    publicationRef: policy.publicationRef,
    publicationRefTip,
    publicationObservedAt: now.toISOString(),
    result: {
      resultId: result.resultId,
      contract: result.contract,
      schemaVersion: result.schemaVersion,
      executionVerdict: result.execution.verdict,
      executionScope: result.execution.scope,
      acceptanceVerdict: result.acceptance.verdict,
      acceptedScope: result.acceptance.acceptedScope,
      evidenceProfile: result.evidence.profile,
      evidenceRefs: result.evidence.refs,
    },
    priorStage,
    taskSnapshotSha256,
    reconciliationStatus: "VERIFIED_WITH_LIMITATIONS",
      verificationLimitations: [
      "ACCEPTANCE_SCOPE_SEMANTICS_NOT_MACHINE_PROVEN",
      "NETLIFY_MANIFEST_URL_BYTES_NOT_REFETCHED",
      "NETLIFY_PRODUCTION_ALIAS_NOT_RECHECKED",
    ],
    projectResultDisposition,
    recordedAt: now.toISOString(),
  };
}

async function verifyProfileEvidence(result: ProjectOwnedResult, repositoryRoot: string, policy: ProjectOwnedResultPolicy): Promise<void> {
  const refs = result.evidence.refs;
  const refsById = new Map(refs.map((reference) => [reference.id, reference]));
  if (refsById.size !== refs.length) throw new InvalidTaskStateError("Project result evidence reference IDs must be unique");
  const requiredIds = [
    result.evidence.case.runtimeLogEvidenceRefId,
    result.evidence.case.snapshot.evidenceRefId,
    result.evidence.case.netlify.immutableManifestVerification.evidenceRefId,
    result.evidence.case.netlify.productionAliasVerification.evidenceRefId,
    ...result.evidence.case.schedulerEvents.map((event) => event.evidenceRefId),
  ];
  if (requiredIds.some((id) => !refsById.has(id))) throw new InvalidTaskStateError("Profile-specific verification points to a missing evidence reference");
  const runtimeLogRef = refsById.get(result.evidence.case.runtimeLogEvidenceRefId);
  if (runtimeLogRef === undefined || runtimeLogRef.sha256 !== result.evidence.case.runtimeLogSha256) {
    throw new InvalidTaskStateError("Runtime log digest does not match its immutable evidence reference");
  }
  const snapshotRef = refsById.get(result.evidence.case.snapshot.evidenceRefId);
  if (snapshotRef === undefined || snapshotRef.kind !== "git-blob"
    || snapshotRef.commitSha !== result.evidence.case.snapshot.commitSha
    || snapshotRef.blobOid !== result.evidence.case.snapshot.gitBlobOid
    || snapshotRef.sha256 !== result.evidence.case.snapshot.gitBlobSha256) {
    throw new InvalidTaskStateError("Snapshot provenance does not match its immutable Git evidence reference");
  }
  for (const reference of refs) {
    if (reference.kind === "git-blob") {
      if (!sameIdentity(reference.repositoryIdentity, policy.projectIdentity)) throw new InvalidTaskStateError("Cross-project Git evidence is not enabled by this result profile");
      await verifyGitEvidence(repositoryRoot, reference);
    } else {
      const url = new URL(reference.url);
      const manifestCheck = result.evidence.case.netlify.immutableManifestVerification;
      const revision = url.searchParams.get("revision");
      if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0
        || url.searchParams.size !== 1 || revision !== result.evidence.case.snapshot.commitSha
        || reference.id !== manifestCheck.evidenceRefId
        || reference.url !== result.evidence.case.netlify.immutableManifestUrl
        || url.protocol !== "https:"
        || url.pathname !== "/deployment-manifest.json"
        || !url.hostname.endsWith(".netlify.app")
        || !url.hostname.startsWith(`${result.evidence.case.netlify.deployId.toLowerCase()}--`)) {
        throw new InvalidTaskStateError("HTTPS evidence must be the exact immutable Netlify manifest URL pinned to the snapshot revision");
      }
      const matchingGitBlobs = refs.filter((candidate) => candidate.kind === "git-blob" && candidate.sha256 === reference.sha256);
      if (matchingGitBlobs.length !== 1) {
        throw new InvalidTaskStateError("Immutable Netlify manifest digest must match exactly one independently verified project Git blob");
      }
    }
  }
  if (result.evidence.case.netlify.immutableManifestVerification.verdict !== "PASS"
    || result.evidence.case.netlify.productionAliasVerification.verdict !== "PASS") {
    throw new InvalidTaskStateError("Project result does not report PASS for both required Netlify verification checks");
  }
}

async function verifyGitEvidence(repositoryRoot: string, reference: Extract<ProjectOwnedEvidenceReference, { readonly kind: "git-blob" }>): Promise<void> {
  const commit = await gitOutput(repositoryRoot, ["rev-parse", "--verify", `${reference.commitSha}^{commit}`], "resolve immutable evidence commit");
  if (!sameIdentity(commit, reference.commitSha)) throw new InvalidTaskStateError(`Evidence commit did not resolve: ${reference.id}`);
  const blob = await gitOutput(repositoryRoot, ["rev-parse", "--verify", `${reference.commitSha}:${reference.path}`], "resolve immutable evidence blob");
  if (!sameIdentity(blob, reference.blobOid)) throw new InvalidTaskStateError(`Evidence blob OID does not match: ${reference.id}`);
  const content = await gitContent(repositoryRoot, ["show", `${reference.commitSha}:${reference.path}`], "read immutable evidence blob");
  if (sha256(content) !== reference.sha256.toLowerCase()) throw new InvalidTaskStateError(`Evidence SHA-256 does not match: ${reference.id}`);
}

async function verifyPublishedCommit(repositoryRoot: string, remote: string, ref: string, commitSha: string): Promise<string> {
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9._/-]+$/u.test(ref) || ref.split("/").some((segment) => segment === ".." || segment === ".")) {
    throw new InvalidTaskStateError("Configured publication ref is invalid");
  }
  const output = await gitOutput(repositoryRoot, ["ls-remote", "--refs", remote, ref], "verify canonical publication ref");
  const lines = output.split(/\r?\n/u).filter((line) => line.length > 0).map((line) => line.split(/\s+/u));
  if (lines.length !== 1 || lines[0]?.[1] !== ref || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(lines[0]?.[0] ?? "")) {
    throw new InvalidTaskStateError("Canonical publication ref returned missing or ambiguous data");
  }
  const remoteTip = lines[0]?.[0];
  if (remoteTip === undefined) throw new InvalidTaskStateError("Canonical publication ref has no commit");
  const localRemoteTip = await gitOutput(repositoryRoot, ["rev-parse", "--verify", `${remoteTip}^{commit}`], "resolve canonical publication tip locally");
  if (!sameIdentity(remoteTip, localRemoteTip)) throw new InvalidTaskStateError("Canonical publication tip is not present as the same local commit object");
  await gitCheck(repositoryRoot, ["merge-base", "--is-ancestor", commitSha, remoteTip], "verify result commit is reachable from canonical publication ref");
  return remoteTip;
}

async function gitConfigValues(repositoryRoot: string, key: string): Promise<readonly string[]> {
  try {
    const result = await runCommand({ command: "git", arguments: ["config", "--null", "--get-all", key], cwd: repositoryRoot, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
    const values = result.stdout.split("\0");
    if (values.pop() !== "") throw new InvalidTaskStateError("Git remote configuration returned malformed output");
    return values;
  } catch (error: unknown) {
    if (error instanceof InvalidTaskStateError) throw error;
    if (error instanceof CommandExecutionError && error.result.exitCode === 1 && error.result.stdout.length === 0 && error.result.stderr.length === 0) return [];
    throw new InvalidTaskStateError("Unable to inspect project-owned Git remote configuration");
  }
}

async function gitOutput(repositoryRoot: string, args: readonly string[], label: string): Promise<string> {
  const result = await runCommand({ command: "git", arguments: args, cwd: repositoryRoot, timeoutMs: 30_000, maxOutputBytes: 16_777_216 });
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new InvalidTaskStateError(`${label} failed: ${redactSensitiveText([result.stdout, result.stderr].join("\n").trim())}`);
  }
  return result.stdout.trim();
}

async function gitContent(repositoryRoot: string, args: readonly string[], label: string): Promise<Buffer> {
  try {
    const result = await execFileBuffer("git", [...args], {
      cwd: repositoryRoot,
      encoding: "buffer",
      timeout: 30_000,
      maxBuffer: 16_777_216,
      windowsHide: true,
    });
    if (!Buffer.isBuffer(result.stdout)) throw new InvalidTaskStateError(`${label} returned an unsupported output encoding`);
    if (result.stdout.includes(0)) throw new InvalidTaskStateError(`${label} returned unsupported binary content`);
    return result.stdout;
  } catch {
    throw new InvalidTaskStateError(`${label} failed or exceeded its bounded output/time limit`);
  }
}

async function gitCheck(repositoryRoot: string, args: readonly string[], label: string): Promise<void> {
  const result = await runCommand({ command: "git", arguments: args, cwd: repositoryRoot, timeoutMs: 30_000, maxOutputBytes: 1_048_576 });
  if (result.exitCode !== 0) throw new InvalidTaskStateError(`${label} failed: ${redactSensitiveText([result.stdout, result.stderr].join("\n").trim())}`);
}

function taskAuditDirectory(auditRoot: string, taskId: string): string {
  if (!isDurableTaskId(taskId)) throw new InvalidTaskStateError("Invalid task id for project-owned audit path");
  return join(auditRoot, taskId, "project-owned-results");
}

export function defaultProjectOwnedAuditRoot(): string {
  return join(homedir(), ".dai-project-owned-audits");
}

export function parseWindowsAuditAclOutput(
  output: string,
  requestedPath: string,
  currentName: string,
  currentSid: string,
  scope: "private" | "parent" | "ancestor" = "private",
): void {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  const [pathLine, ...remaining] = lines;
  const pathSuffix = pathLine?.slice(requestedPath.length) ?? "";
  if (pathLine === undefined || pathLine.slice(0, requestedPath.length).toLowerCase() !== requestedPath.toLowerCase()
    || (pathSuffix.length > 0 && !/^\s/u.test(pathSuffix))) {
    throw new InvalidTaskStateError("icacls output did not name the exact audit directory");
  }
  const firstAce = pathLine.slice(requestedPath.length).trim();
  const aceLines = [firstAce, ...remaining].filter((line) => line.length > 0
    && !/^Successfully processed \d+ files; Failed processing 0 files$/iu.test(line));
  const allowed = new Set([currentName.toLowerCase(), currentSid.toLowerCase(), "nt authority\\system", "s-1-5-18", "builtin\\administrators", "s-1-5-32-544"]);
  const inheritanceFlags = new Set(["OI", "CI", "IO", "NP", "I", "NW"]);
  const accessRights = new Set(["N", "F", "M", "RX", "R", "W", "D", "WDAC", "WO", "S", "AS", "MA", "DE", "DC", "RA", "X", "RD", "WD", "AD", "REA", "WEA", "RC", "WA", "GR", "GW", "GX", "GA", "GE"]);
  const writeRights = new Set(["F", "M", "W", "D", "WDAC", "WO", "DE", "DC", "WD", "AD", "WEA", "WA", "AS", "MA", "GW", "GA"]);
  const unsafeAncestorRights = new Set(["F", "M", "W", "D", "WDAC", "WO", "DE", "DC", "WD", "WEA", "WA", "AS", "MA", "GW", "GA"]);
  const unsafeParentRights = new Set([...unsafeAncestorRights, "AD"]);
  let allowCount = 0;
  let currentUserCanWrite = false;
  let aceCount = 0;
  for (const line of aceLines) {
    const delimiter = line.indexOf(":(");
    if (delimiter <= 0) throw new InvalidTaskStateError("icacls output contains an unrecognized ACL entry");
    const principal = line.slice(0, delimiter).trim().toLowerCase();
    const tokens = [...line.slice(delimiter + 1).matchAll(/\(([A-Z0-9,]+)\)/giu)]
      .flatMap((match) => match[1]!.split(",").map((token) => token.toUpperCase()));
    if (tokens.length === 0 || tokens.join("") !== line.slice(delimiter + 1).replace(/[(),]/gu, "").toUpperCase()) {
      throw new InvalidTaskStateError("icacls output contains malformed rights");
    }
    if (tokens.includes("DENY") || tokens.some((token) => !inheritanceFlags.has(token) && !accessRights.has(token))) {
      throw new InvalidTaskStateError("icacls output contains unsupported ACL rights");
    }
    const mandatoryLabel = principal.startsWith("mandatory label\\") && tokens.every((token) => inheritanceFlags.has(token));
    if (!tokens.some((token) => accessRights.has(token)) && !mandatoryLabel) throw new InvalidTaskStateError("icacls entry grants no recognized access right");
    aceCount += 1;
    const inheritOnly = tokens.includes("IO");
    const unsafeRights = scope === "parent" ? unsafeParentRights : unsafeAncestorRights;
    if (!mandatoryLabel && scope !== "private" && !inheritOnly && !allowed.has(principal)
      && tokens.some((token) => unsafeRights.has(token))) {
      throw new InvalidTaskStateError("An untrusted principal has a write-capable audit-path ACE");
    }
    if (!mandatoryLabel && scope === "private" && !allowed.has(principal)) throw new InvalidTaskStateError("An untrusted principal has an audit-directory allow ACE");
    allowCount += mandatoryLabel ? 0 : scope === "private" || allowed.has(principal) ? 1 : 0;
    if ((principal === currentName.toLowerCase() || principal === currentSid.toLowerCase()) && tokens.some((token) => writeRights.has(token))) {
      currentUserCanWrite = true;
    }
  }
  if (aceCount === 0) throw new InvalidTaskStateError("icacls output contains no ACL entries");
  if (scope === "private" && (allowCount === 0 || !currentUserCanWrite)) {
    throw new InvalidTaskStateError("icacls output contains no trusted allow ACE for the current user");
  }
}

export async function assertPrivateDirectory(path: string, privateRoot = path): Promise<void> {
  const leaf = resolve(path);
  const protectedRoot = resolve(privateRoot);
  const pathFromRoot = relative(protectedRoot, leaf);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new InvalidTaskStateError("Project-owned audit path is outside its private root");
  }
  const privatePaths = new Set<string>();
  let current = leaf;
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new InvalidTaskStateError("Project-owned audit path components must be real directories, not links");
    const fromPrivateRoot = relative(protectedRoot, current);
    if (fromPrivateRoot === "" || (!fromPrivateRoot.startsWith("..") && !isAbsolute(fromPrivateRoot))) privatePaths.add(current);
    const unsafeMode = privatePaths.has(current)
      ? (info.mode & 0o077) !== 0
      : (info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0;
    if (process.platform !== "win32" && unsafeMode) {
      throw new InvalidTaskStateError("Project-owned audit directories or their ancestors have unsafe permissions");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (process.platform === "win32") {
    try {
      const whoami = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
      const identity = /^"([^"]+)","([^"]+)"/u.exec(whoami.trim());
      const currentName = identity?.[1]?.toLowerCase();
      const currentSid = identity?.[2]?.toLowerCase();
      if (currentName === undefined || currentSid === undefined) throw new Error("Current Windows identity could not be resolved");
      for (let directory = leaf; ; directory = dirname(directory)) {
        const acl = execFileSync("icacls.exe", [directory], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true });
        const scope = privatePaths.has(directory) ? "private" : directory === dirname(protectedRoot) ? "parent" : "ancestor";
        parseWindowsAuditAclOutput(acl, directory, currentName, currentSid, scope);
        const parent = dirname(directory);
        if (parent === directory) break;
      }
    } catch {
      throw new InvalidTaskStateError("Project-owned audit directory ACL is not verified as private to the current user, SYSTEM, and Administrators");
    }
  }
}

export function hardenNewWindowsAuditRoot(path: string): void {
  const whoami = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 5_000, windowsHide: true });
  const identity = /^"([^"]+)","([^"]+)"/u.exec(whoami.trim());
  const sid = identity?.[2];
  if (sid === undefined) throw new InvalidTaskStateError("Current Windows identity could not be resolved to initialize the local audit root");
  execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
}

function auditMatchesPolicy(audit: ProjectOwnedReconciliationAudit, policy: ProjectOwnedResultPolicy): boolean {
  return audit.projectIdentity === policy.projectIdentity
    && audit.workId === policy.workId
    && audit.executionOwnerId === policy.executionOwnerId
    && audit.priorStage === "route"
    && audit.publicationRef === policy.publicationRef
    && audit.confirmation.project.identity === policy.projectIdentity
    && audit.confirmation.project.workId === policy.workId
    && audit.confirmation.project.executionOwnerId === policy.executionOwnerId
    && audit.confirmation.dai.taskId === policy.taskId
    && audit.confirmation.artifact.repositoryIdentity === policy.projectIdentity
    && audit.confirmation.artifact.canonicalPath === policy.canonicalArtifactPath
    && audit.confirmation.artifact.publicationCommitSha === audit.source.commitSha
    && audit.confirmation.artifact.gitBlobOid === audit.source.blobOid
    && audit.confirmation.artifact.sha256 === audit.source.sha256.toLowerCase()
    && audit.confirmation.result.resultId === audit.result.resultId
    && canonicalJson(audit.confirmation.evidenceRefs) === canonicalJson(audit.result.evidenceRefs);
}

function taskSnapshotDigest(state: TaskState): string {
  return sha256(canonicalJson(state));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new InvalidTaskStateError("Cannot serialize undefined project-owned audit data");
  return result;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameBinding(event: HumanConfirmationEvent, binding: HumanConfirmationBinding): boolean {
  return canonicalJson({ project: event.project, dai: event.dai, result: event.result, artifact: event.artifact, evidenceRefs: event.evidenceRefs })
    === canonicalJson(binding);
}

function sameAuditPayload(left: ProjectOwnedReconciliationAudit, right: ProjectOwnedReconciliationAudit): boolean {
  return left.confirmation.eventId === right.confirmation.eventId
    && canonicalJson(left.confirmation) === canonicalJson(right.confirmation)
    && canonicalJson(left.source) === canonicalJson(right.source);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
