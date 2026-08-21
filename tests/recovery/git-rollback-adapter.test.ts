import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { createGitRollbackTask } from "../../src/recovery/git-rollback-adapter.js";
import type { RecoverySnapshot, TaskState } from "../../src/domain/types.js";

async function git(repositoryPath: string, argumentsList: readonly string[]): Promise<string> {
  return (await runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath })).stdout.trim();
}

async function createRepository(): Promise<{ readonly root: string; readonly recoveryHead: string; readonly currentHead: string; readonly snapshot: RecoverySnapshot }> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-rollback-"));
  await git(root, ["init", "--initial-branch=main"]);
  await git(root, ["config", "user.email", "d-ai@example.test"]);
  await git(root, ["config", "user.name", "D-AI Test"]);
  await writeFile(join(root, "artifact.txt"), "known good\n", "utf8");
  await git(root, ["add", "artifact.txt"]);
  await git(root, ["commit", "-m", "known good"]);
  const recoveryHead = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "artifact.txt"), "regression\n", "utf8");
  await git(root, ["add", "artifact.txt"]);
  await git(root, ["commit", "-m", "regression"]);
  const currentHead = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(join(root, "user-work.txt"), "must survive\n", "utf8");
  const binaryPatch = "";
  const snapshot: RecoverySnapshot = {
    head: recoveryHead,
    branch: "main",
    workspacePath: root,
    status: "",
    binaryPatch,
    stateManifest: { manifestId: "00000000-0000-4000-8000-000000000010", taskId: "task-git-rollback", stage: "verify", environment: "codex", role: "evidence-collector", durablePaths: ["state.json"], hashes: { "state.json": "a".repeat(64) }, recoveryPointId: "recovery-git-rollback", recordedAt: "2026-08-21T00:00:00.000Z" },
    verificationResults: [{ evidenceId: "evidence-git-rollback", stage: "verify", environment: "codex", role: "evidence-collector", selectedModel: "model", command: "git status", observedOutput: "passed", exitCode: 0, interpretation: "passed", passed: true, recoveryPointId: "recovery-git-rollback", recordedAt: "2026-08-21T00:00:00.000Z" }],
    durableArtifacts: { "state.json": "a".repeat(64) },
  };
  return { root, recoveryHead, currentHead, snapshot };
}

function state(snapshot: RecoverySnapshot): TaskState {
  return {
    taskId: "task-git-rollback",
    goal: "rollback",
    constraints: [],
    environment: "codex",
    stage: "verify",
    role: "evidence-collector",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: [],
    handoffState: "none",
    verificationEvidence: snapshot.verificationResults,
    recoveryPoint: { recoveryPointId: "recovery-git-rollback", taskId: "task-git-rollback", stage: "verify", environment: "codex", role: "evidence-collector", durablePaths: ["state.json"], hashes: { "state.json": "a".repeat(64) }, restorationInstructions: "restore", createdAt: "2026-08-21T00:00:00.000Z", snapshotManifestId: snapshot.stateManifest.manifestId },
    recoverySnapshot: snapshot,
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext: snapshot.stateManifest,
  };
}

describe("Git rollback adapter", () => {
  it("preserves user work, reverts post-recovery commits, restores the patch, and verifies the snapshot", async () => {
    const fixture = await createRepository();
    try {
      const result = await createGitRollbackTask(fixture.root)(state(fixture.snapshot), { taskId: "task-git-rollback", environment: "codex", generation: 1n, ownerToken: "00000000-0000-4000-8000-000000000001" });
      expect(result.verification.passed).toBe(true);
      expect(result.actions.map((action) => action.arguments[0])).toEqual(["revert", "apply"]);
      expect(result.preservedUserWork.patchDigest).toBe(createHash("sha256").update("", "utf8").digest("hex"));
      await expect(git(fixture.root, ["rev-parse", "HEAD"])).resolves.not.toBe(fixture.recoveryHead);
      await expect(git(fixture.root, ["show", "HEAD:artifact.txt"])).resolves.toBe("known good");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the restored tree does not match the recovery point", async () => {
    const fixture = await createRepository();
    try {
      const mismatched = { ...fixture.snapshot, status: " M artifact.txt" };
      await expect(createGitRollbackTask(fixture.root)(state(mismatched), { taskId: "task-git-rollback", environment: "codex", generation: 1n, ownerToken: "00000000-0000-4000-8000-000000000001" })).rejects.toThrow(/recovery point verification failed/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
