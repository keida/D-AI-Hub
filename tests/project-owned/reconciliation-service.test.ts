import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as commandRunner from "../../src/adapters/command-runner.js";
import { prepareBootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import type { TaskState } from "../../src/domain/types.js";
import { HumanConfirmationVerifier, humanConfirmationEventSchema } from "../../src/project-owned/authority-verifier.js";
import { assertPrivateDirectory, hardenNewWindowsAuditRoot, ProjectOwnedReconciliationService } from "../../src/project-owned/project-owned-reconciliation.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

const roots: string[] = [];
const identity = "github.com/keida/skill-pulse";
const taskId = "task-0123456789abcdef";
const artifactPath = "docs/project-results/result.json";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProjectOwnedReconciliationService", () => {
  it("serializes concurrent confirmations, recovers a fresh audit, and replays idempotently without advancing route", async () => {
    const root = await mkdtemp(join(homedir(), ".dai-project-owned-"));
    roots.push(root);
    if (process.platform === "win32") hardenNewWindowsAuditRoot(root);
    const workspacePath = join(root, "workspace");
    const repositoryPath = join(workspacePath, "repo");
    const storeRoot = join(root, "state");
    const auditRoot = join(root, "audit");
    await mkdir(repositoryPath, { recursive: true });
    await mkdir(auditRoot, { recursive: true, mode: 0o700 });
    if (process.platform === "win32") hardenNewWindowsAuditRoot(auditRoot);
    const { commitSha, source } = await makePublishedResult(repositoryPath);
    const store = new FileDurableContextStore(storeRoot);
    const prepared = await prepareBootstrapTask({ taskId, goal: "reconcile published project result", environment: "codex", workspacePath, repositoryPath }, store);
    const state: TaskState = {
      ...prepared,
      stage: "route",
      contextManifest: [...prepared.contextManifest, `remote-repository:${identity}`],
    };
    await store.createIfAbsent?.(state);

    const originalRun = commandRunner.runCommand;
    const remoteRef = "refs/heads/master";
    vi.spyOn(commandRunner, "runCommand").mockImplementation(async (request) => {
      if (request.arguments[0] === "ls-remote") {
        return { command: request.command, arguments: request.arguments, stdout: `${commitSha}\t${remoteRef}\n`, stderr: "", exitCode: 0 };
      }
      return originalRun(request);
    });

    let releaseConfirmations: (() => void) | undefined;
    let arrivals = 0;
    const bothArrived = new Promise<void>((resolve) => { releaseConfirmations = resolve; });
    vi.spyOn(HumanConfirmationVerifier.prototype, "capture").mockImplementation(async (binding) => {
        arrivals += 1;
        if (arrivals === 2) releaseConfirmations?.();
        await bothArrived;
        return humanConfirmationEventSchema.parse({
          contract: "dai.project-result-confirmation",
          schemaVersion: 1,
          eventId: randomUUID(),
          authorityState: "HUMAN-CONFIRMED",
          intent: "RECONCILE_PROJECT_OWNED_RESULT",
          ...binding,
          confirmedAt: new Date().toISOString(),
          operatorContext: { host: "local", sessionId: "test-session", interactionId: randomUUID() },
        });
    });
    const policy = {
      taskId,
      projectIdentity: identity,
      workId: "SP-OPS-006",
      executionOwnerId: "worker-1",
      workspacePath,
      repositoryPath,
      canonicalArtifactPath: artifactPath,
      publicationRemote: "origin",
      publicationRef: remoteRef,
    };
    const service = new ProjectOwnedReconciliationService({ store, auditRoot, policy });
    const request = { taskId, source };
    const responses = await Promise.all([service.reconcile(request), service.reconcile(request)]);
    expect(responses.filter((response) => response.status === "reconciled"), JSON.stringify(responses)).toHaveLength(1);
    expect(responses.filter((response) => response.status === "blocked")).toHaveLength(1);
    expect((await store.load(taskId))?.stage).toBe("route");

    const winner = responses.find((response) => response.status === "reconciled");
    if (winner?.status !== "reconciled") throw new Error("Expected one durable reconciliation winner");
    expect(winner.audit.priorStage).toBe("route");
    expect(winner.audit.projectResultDisposition).toBe("HANDOFF_VERIFIED_AWAITING_CLOSE_DECISION");
    expect(winner.audit.reconciliationStatus).toBe("VERIFIED_WITH_LIMITATIONS");
    expect(winner.audit.verificationLimitations).toContain("NETLIFY_MANIFEST_URL_BYTES_NOT_REFETCHED");
    expect(winner.audit.result.executionScope).not.toEqual(winner.audit.result.acceptedScope);

    const freshService = new ProjectOwnedReconciliationService({ store: new FileDurableContextStore(storeRoot), auditRoot, policy });
    const recovered = await freshService.recover(taskId);
    expect(recovered?.task.stage).toBe("route");
    expect(recovered?.projectOwnedReconciliations).toHaveLength(1);
    expect(recovered?.projectOwnedReconciliations[0]?.confirmationConsumed).toBe(true);
    const replay = await freshService.reconcile({ ...request, replayEventId: winner.audit.confirmation.eventId });
    expect(replay).toMatchObject({ status: "reconciled", replayed: true, audit: { ...winner.audit, confirmationConsumed: true } });
    const forgedRequest = await freshService.reconcile({ ...request, confirmation: winner.audit.confirmation });
    expect(forgedRequest.status).toBe("blocked");
    expect(arrivals).toBe(2);

    const auditDirectory = join(auditRoot, taskId, "project-owned-results");
    const auditFiles = (await readdir(auditDirectory)).filter((name) => name.endsWith(".json"));
    expect(auditFiles).toHaveLength(1);
    const [filename] = auditFiles;
    if (filename === undefined) throw new Error("Expected durable audit file");
    const auditPath = join(auditDirectory, filename);
    const envelope = JSON.parse(await readFile(auditPath, "utf8")) as { audit: { confirmationConsumed: boolean; taskSnapshotSha256: string }; auditSha256: string };
    envelope.audit.confirmationConsumed = false;
    await writeFile(auditPath, JSON.stringify(envelope), "utf8");
    await expect(freshService.recover(taskId)).rejects.toThrow();
    envelope.audit.confirmationConsumed = true;
    envelope.audit.taskSnapshotSha256 = `${envelope.audit.taskSnapshotSha256[0] === "0" ? "1" : "0"}${envelope.audit.taskSnapshotSha256.slice(1)}`;
    await writeFile(auditPath, JSON.stringify(envelope), "utf8");
    await expect(freshService.recover(taskId)).rejects.toThrow("checksum or policy-binding check failed");
  });

});

it.skipIf(process.platform !== "win32")("accepts a hardened Windows private root and rejects inherited or parent delete-child access", async () => {
  const root = await mkdtemp(join(homedir(), ".dai-audit-acl-"));
  roots.push(root);
  const inheritedRoot = join(root, "inherited");
  const privateRoot = join(root, "private");
  const unsafeParent = join(root, "unsafe-parent");
  const protectedChild = join(unsafeParent, "protected-child");
  const unsafeAddParent = join(root, "unsafe-add-parent");
  const protectedAddChild = join(unsafeAddParent, "protected-add-child");
  hardenNewWindowsAuditRoot(root);
  await mkdir(inheritedRoot, { mode: 0o700 });
  await mkdir(privateRoot, { mode: 0o700 });
  await mkdir(unsafeParent, { mode: 0o700 });

  execFileSync("icacls.exe", [inheritedRoot, "/grant", "*S-1-1-0:(RX)"], { encoding: "utf8", windowsHide: true });
  await expect(assertPrivateDirectory(inheritedRoot)).rejects.toThrow("ACL is not verified as private");
  hardenNewWindowsAuditRoot(privateRoot);
  await expect(assertPrivateDirectory(privateRoot)).resolves.toBeUndefined();

  await mkdir(protectedChild, { recursive: true, mode: 0o700 });
  hardenNewWindowsAuditRoot(protectedChild);
  execFileSync("icacls.exe", [unsafeParent, "/grant", "*S-1-1-0:(DC)"], { encoding: "utf8", windowsHide: true });
  await expect(assertPrivateDirectory(protectedChild)).rejects.toThrow("ACL is not verified as private");

  await mkdir(protectedAddChild, { recursive: true, mode: 0o700 });
  hardenNewWindowsAuditRoot(protectedAddChild);
  execFileSync("icacls.exe", [unsafeAddParent, "/grant", "*S-1-1-0:(AD)"], { encoding: "utf8", windowsHide: true });
  await expect(assertPrivateDirectory(protectedAddChild)).rejects.toThrow("ACL is not verified as private");
});

async function makePublishedResult(repositoryPath: string): Promise<{ commitSha: string; source: { repositoryPath: string; commitSha: string; artifactPath: string; blobOid: string; sha256: string } }> {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repositoryPath, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "worker@example.invalid");
  git("config", "user.name", "Worker");
  git("remote", "add", "origin", "https://github.com/keida/skill-pulse.git");

  const evidenceFiles: Record<string, string> = {
    "evidence/runtime.log": "natural scheduler run completed\nAuthorization: Bearer demo\n",
    "evidence/snapshot.json": "{\"snapshot\":true}\n",
    "evidence/deployment-manifest.json": "{\"deployId\":\"0123456789abcdef01234567\"}\n",
    "evidence/production-alias.json": "{\"observed\":\"historical-pass\"}\n",
  };
  for (const [path, contents] of Object.entries(evidenceFiles)) {
    const fullPath = join(repositoryPath, path);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "add immutable evidence");
  const evidenceCommit = git("rev-parse", "HEAD");
  const blob = (path: string) => git("rev-parse", `${evidenceCommit}:${path}`);
  const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const gitRef = (id: string, path: string) => ({
    id,
    kind: "git-blob" as const,
    repositoryIdentity: identity,
    commitSha: evidenceCommit,
    path,
    blobOid: blob(path),
    sha256: hash(evidenceFiles[path]!),
  });
  const manifestGitRef = gitRef("manifest-git", "evidence/deployment-manifest.json");
  const deployId = "0123456789abcdef01234567";
  const result = {
    contract: "dai.project-result",
    schemaVersion: 1,
    resultId: "sp-ops-006-test-result",
    project: { identity, workId: "SP-OPS-006", executionOwnerId: "worker-1" },
    dai: { taskId },
    execution: { verdict: "PASS", scope: ["natural scheduler run", "snapshot published"] },
    acceptance: { verdict: "ACCEPTED", authorityId: "project-boss", acceptedScope: ["historical evidence considered", "caveats retained"], acceptedAt: "2026-09-25T00:00:00.000Z" },
    evidence: {
      profile: "skill-pulse.sp-ops-006/v1",
      refs: [
        gitRef("runtime-log", "evidence/runtime.log"),
        gitRef("snapshot", "evidence/snapshot.json"),
        manifestGitRef,
        gitRef("production-alias", "evidence/production-alias.json"),
        { id: "manifest-url", kind: "https-object", url: `https://${deployId}--skill-pulse-preview.netlify.app/deployment-manifest.json?revision=${evidenceCommit}`, immutableId: deployId, sha256: manifestGitRef.sha256 },
      ],
      case: {
        naturalSchedulerInstanceId: "scheduled-run-1",
        schedulerEvents: [{ eventId: 1, recordId: 2, evidenceRefId: "runtime-log" }],
        runtimeLogSha256: hash(evidenceFiles["evidence/runtime.log"]!),
        runtimeLogEvidenceRefId: "runtime-log",
        snapshot: { commitSha: evidenceCommit, gitBlobOid: blob("evidence/snapshot.json"), gitBlobSha256: hash(evidenceFiles["evidence/snapshot.json"]!), evidenceRefId: "snapshot" },
        netlify: {
          deployId,
          immutableManifestUrl: `https://${deployId}--skill-pulse-preview.netlify.app/deployment-manifest.json?revision=${evidenceCommit}`,
          immutableManifestVerification: { check: "immutable-deploy-manifest", verdict: "PASS", checkedAt: "2026-09-25T00:00:00.000Z", evidenceRefId: "manifest-url" },
          productionAliasVerification: { check: "production-alias", verdict: "PASS", checkedAt: "2026-09-25T00:00:00.000Z", evidenceRefId: "production-alias" },
        },
      },
    },
  };
  const artifact = JSON.stringify(result, null, 2) + "\n";
  const artifactFullPath = join(repositoryPath, artifactPath);
  await mkdir(join(artifactFullPath, ".."), { recursive: true });
  await writeFile(artifactFullPath, artifact, "utf8");
  git("add", artifactPath);
  git("commit", "--quiet", "-m", "publish typed project result");
  const commitSha = git("rev-parse", "HEAD");
  return {
    commitSha,
    source: {
      repositoryPath,
      commitSha,
      artifactPath,
      blobOid: git("rev-parse", `${commitSha}:${artifactPath}`),
      sha256: hash(artifact),
    },
  };
}
