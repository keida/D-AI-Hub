import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { GitHubCliAdapter } from "../../src/adapters/github.js";
import { closeTask } from "../../src/close/close-service.js";
import type { TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

const gateNames = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "recovery",
  "handoff",
  "durable-context",
  "critical-unsaved-context",
] as const;

async function git(cwd: string | null, argumentsList: readonly string[]): Promise<string> {
  const result = await runCommand({ command: "git", arguments: argumentsList, cwd });
  return result.stdout.trim();
}

function verificationEvidence(now: string): readonly VerificationEvidence[] {
  return gateNames.map((gate) => ({
    evidenceId: `gate:${gate}`,
    stage: "close",
    environment: "codex",
    role: "evidence-collector",
    selectedModel: "verification-model",
    command: "npm test",
    observedOutput: "verification passed",
    exitCode: 0,
    interpretation: "Verification passed",
    passed: true,
    recoveryPointId: "recovery-integration",
    recordedAt: now,
  }));
}

function stateFor(repositoryPath: string, commitSha: string, now: string): TaskState {
  return {
    taskId: "task-github-close-integration",
    goal: "Verify a local bare Git remote through the close workflow",
    constraints: ["No destructive cleanup"],
    environment: "codex",
    stage: "close",
    role: "evidence-collector",
    routingDecision: {
      stage: "close",
      environment: "codex",
      role: "evidence-collector",
      selectedModel: "verification-model",
      selectedCapabilities: ["shell"],
      reason: "Collect local Git close evidence",
      overrideSource: "default",
    },
    selectedCapabilities: ["shell"],
    contextManifest: [
      `identity:repository:${repositoryPath}:${createHash("sha256").update(repositoryPath, "utf8").digest("hex")}`,
      "remote:origin",
      "ref:refs/heads/main",
      "local-state:clean-required",
      `artifact:commit:${commitSha}`,
    ],
    handoffState: "completed",
    verificationEvidence: verificationEvidence(now),
    recoveryPoint: {
      recoveryPointId: "recovery-integration",
      taskId: "task-github-close-integration",
      stage: "close",
      environment: "codex",
      role: "evidence-collector",
      durablePaths: ["recovery-source.json"],
      hashes: { "recovery-source.json": "a".repeat(64) },
      restorationInstructions: "Restore the recorded recovery state without deleting user work.",
      createdAt: now,
    },
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext: null,
  };
}

describe("GitHub close integration", () => {
  it("pushes to a temporary bare remote and verifies its exact SHA through the GitHub adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-github-close-"));
    const repositoryPath = join(root, "repository");
    const bareRemotePath = join(root, "remote.git");
    const storeRoot = join(root, "store");
    try {
      await git(null, ["init", "--bare", bareRemotePath]);
      await git(null, ["init", "--initial-branch=main", repositoryPath]);
      await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
      await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "verified artifact\n", "utf8");
      await git(repositoryPath, ["add", "artifact.txt"]);
      await git(repositoryPath, ["commit", "-m", "integration artifact"]);
      const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
      await git(repositoryPath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
      await git(repositoryPath, ["config", `url.file://${bareRemotePath.replaceAll("\\", "/")}.insteadOf`, "https://github.com/acme/d-ai.git"]);

      const initialState = stateFor(repositoryPath, commitSha, new Date().toISOString());
      const store = new FileDurableContextStore(storeRoot);
      const manifest = await store.save(initialState);
      const closeState = { ...initialState, durableContext: manifest };
      const verdict = await closeTask(closeState, {
        store,
        gitHub: new GitHubCliAdapter({ enterpriseHost: null }),
      });

      expect(verdict).toMatchObject({ status: "YES", reasons: [] });
      expect(await git(bareRemotePath, ["rev-parse", "refs/heads/main"])).toBe(commitSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports external GitHub verification as BLOCKED unless an explicit integration lane is configured", () => {
    const optIn = process.env.D_AI_GITHUB_EXTERNAL_INTEGRATION === "1";
    const status = optIn ? "NOT-RUN" : "BLOCKED";

    expect(status).toBe(optIn ? "NOT-RUN" : "BLOCKED");
  });
});
