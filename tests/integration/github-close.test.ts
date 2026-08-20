import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { GitHubCliAdapter, GitRemoteBlockedError } from "../../src/adapters/github.js";
import { pushGitRef, readRemoteRef, type GitTransport } from "../../src/adapters/git.js";
import { closeTask } from "../../src/close/close-service.js";
import type { DurableContextManifest, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import type { DurableContextStore } from "../../src/state/durable-context-store.js";
import type { GitHubAdapter, GitPushEvidence, RemoteState } from "../../src/adapters/github.js";

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

interface ExternalIntegrationConfiguration {
  readonly repositoryPath: string;
  readonly remote: string;
  readonly ref: string;
  readonly enterpriseHost: string | null;
}

function externalIntegrationConfiguration(): ExternalIntegrationConfiguration | null {
  const repositoryPath = process.env.D_AI_GITHUB_EXTERNAL_REPOSITORY_PATH;
  const remote = process.env.D_AI_GITHUB_EXTERNAL_REMOTE;
  const ref = process.env.D_AI_GITHUB_EXTERNAL_REF;
  if (
    process.env.D_AI_GITHUB_EXTERNAL_INTEGRATION !== "1"
    || process.env.D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED !== "1"
    || repositoryPath === undefined
    || remote === undefined
    || ref === undefined
  ) {
    return null;
  }
  return {
    repositoryPath,
    remote,
    ref,
    enterpriseHost: process.env.D_AI_GITHUB_EXTERNAL_ENTERPRISE_HOST ?? null,
  };
}

function stateFor(repositoryPath: string, commitSha: string, now: string, remote: string, ref: string): TaskState {
  const durablePaths = ["context.json", "evidence.json", "recovery.json"];
  const hashes = {
    "context.json": "a".repeat(64),
    "evidence.json": "b".repeat(64),
    "recovery.json": "c".repeat(64),
  };
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
      `remote:${remote}`,
      `ref:${ref}`,
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
      durablePaths,
      hashes,
      restorationInstructions: "Restore the recorded recovery state without deleting user work.",
      createdAt: now,
    },
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext: {
      manifestId: "00000000-0000-4000-8000-000000000005",
      taskId: "task-github-close-integration",
      stage: "close",
      environment: "codex",
      role: "evidence-collector",
      durablePaths,
      hashes,
      recoveryPointId: "recovery-integration",
      recordedAt: now,
    },
  };
}

function storeFor(state: TaskState): DurableContextStore {
  return {
    load: async (): Promise<TaskState> => state,
    save: async (): Promise<DurableContextManifest> => {
      throw new Error("Close integration must not save durable context");
    },
    recordCriticalUnsavedContext: async (): Promise<void> => {
      throw new Error("Close integration must not record unsaved context");
    },
    clearCriticalUnsavedContext: async (): Promise<void> => {
      throw new Error("Close integration must not clear unsaved context");
    },
  };
}

describe("GitHub close integration", () => {
  it("pushes to a temporary bare remote and verifies its exact SHA through the GitHub adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-github-close-"));
    const repositoryPath = join(root, "repository");
    const bareRemotePath = join(root, "remote.git");
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
      const localBareTransport: GitTransport = {
        pushRef: async (localRepositoryPath, _endpoint, ref, head) => pushGitRef(localRepositoryPath, bareRemotePath, ref, head),
        readRef: async (_localRepositoryPath, _endpoint, ref) => readRemoteRef(bareRemotePath, ref, null),
      };

      const closeState = stateFor(repositoryPath, commitSha, new Date().toISOString(), "origin", "refs/heads/main");
      const verdict = await closeTask(closeState, {
        store: storeFor(closeState),
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, localBareTransport),
      });

      expect(verdict).toMatchObject({ status: "YES", reasons: [] });
      expect(await git(bareRemotePath, ["rev-parse", "refs/heads/main"])).toBe(commitSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a conflicting pushurl before it can divert the push", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-github-pushurl-"));
    const repositoryPath = join(root, "repository");
    const bareRemotePath = join(root, "remote.git");
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
      await git(repositoryPath, ["remote", "set-url", "--push", "origin", `file://${bareRemotePath.replaceAll("\\", "/")}`]);

      const closeState = stateFor(repositoryPath, commitSha, new Date().toISOString(), "origin", "refs/heads/main");
      const verdict = await closeTask(closeState, {
        store: storeFor(closeState),
        gitHub: GitHubCliAdapter.create({ mode: "external", enterpriseHost: null, credentialsConfigured: true }),
      });

      expect(verdict.status).toBe("BLOCKED");
      expect(verdict.reasons.join(" ")).toMatch(/remote|transport|push/i);
      await expect(git(bareRemotePath, ["rev-parse", "--verify", "refs/heads/main"])).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a URL rewrite that diverts the effective push transport", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-github-rewrite-"));
    const repositoryPath = join(root, "repository");
    const bareRemotePath = join(root, "remote.git");
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

      const closeState = stateFor(repositoryPath, commitSha, new Date().toISOString(), "origin", "refs/heads/main");
      const verdict = await closeTask(closeState, {
        store: storeFor(closeState),
        gitHub: GitHubCliAdapter.create({ mode: "external", enterpriseHost: null, credentialsConfigured: true }),
      });

      expect(verdict.status).toBe("BLOCKED");
      expect(verdict.reasons.join(" ")).toMatch(/remote|transport|push/i);
      await expect(git(bareRemotePath, ["rev-parse", "--verify", "refs/heads/main"])).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks chained URL rewrites before Git can divert a validated endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-github-chained-rewrite-"));
    const repositoryPath = join(root, "repository");
    const bareRemotePath = join(root, "remote.git");
    const globalConfigPath = join(root, "global.gitconfig");
    const previousGlobalConfigPath = process.env.GIT_CONFIG_GLOBAL;
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
      await git(null, ["config", "--file", globalConfigPath, "url.git@github.com:acme/d-ai.git.pushInsteadOf", "https://github.com/acme/d-ai.git"]);
      process.env.GIT_CONFIG_GLOBAL = globalConfigPath;
      await git(repositoryPath, ["config", `url.file://${bareRemotePath.replaceAll("\\", "/")}.insteadOf`, "git@github.com:acme/d-ai.git"]);

      const closeState = stateFor(repositoryPath, commitSha, new Date().toISOString(), "origin", "refs/heads/main");
      const verdict = await closeTask(closeState, {
        store: storeFor(closeState),
        gitHub: GitHubCliAdapter.create({ mode: "external", enterpriseHost: null, credentialsConfigured: true }),
      });

      expect(verdict.status).toBe("BLOCKED");
      await expect(git(bareRemotePath, ["rev-parse", "--verify", "refs/heads/main"])).rejects.toThrow();
    } finally {
      if (previousGlobalConfigPath === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = previousGlobalConfigPath;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns BLOCKED when remote verification emits a malformed object id", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-github-malformed-remote-"));
    const repositoryPath = join(root, "repository");
    try {
      await git(null, ["init", "--initial-branch=main", repositoryPath]);
      await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
      await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "malformed remote evidence\n", "utf8");
      await git(repositoryPath, ["add", "artifact.txt"]);
      await git(repositoryPath, ["commit", "-m", "malformed remote evidence"]);
      const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
      await git(repositoryPath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
      const malformedRemoteTransport: GitTransport = {
        pushRef: async () => ({
          pushed: true,
          observedOutput: "Push completed",
          exitCode: 0,
          failureCategory: null,
        }),
        readRef: async (_localRepositoryPath, endpoint, ref) => ({
          command: "git",
          arguments: ["ls-remote", endpoint, ref],
          stdout: `${"e".repeat(41)}\t${ref}\n`,
          stderr: "",
          exitCode: 0,
        }),
      };

      const closeState = stateFor(repositoryPath, commitSha, new Date().toISOString(), "origin", "refs/heads/main");
      const verdict = await closeTask(closeState, {
        store: storeFor(closeState),
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, malformedRemoteTransport),
      });

      expect(verdict.status).toBe("BLOCKED");
      expect(verdict.reasons.join(" ")).toMatch(/malformed|object id|sha/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the external lane opt-in and returns BLOCKED through close when credentials or configuration are missing", async () => {
    const externalConfiguration = externalIntegrationConfiguration();
    if (externalConfiguration !== null) {
      const commitSha = await git(externalConfiguration.repositoryPath, ["rev-parse", "HEAD"]);
      const closeState = stateFor(
        externalConfiguration.repositoryPath,
        commitSha,
        new Date().toISOString(),
        externalConfiguration.remote,
        externalConfiguration.ref,
      );
      const verdict = await closeTask(closeState, {
        store: storeFor(closeState),
        gitHub: GitHubCliAdapter.create({ mode: "external", enterpriseHost: externalConfiguration.enterpriseHost, credentialsConfigured: true }),
      });

      expect(verdict).toMatchObject({ status: "YES", reasons: [] });
      return;
    }

    const root = await mkdtemp(join(tmpdir(), "d-ai-github-external-blocked-"));
    const repositoryPath = join(root, "repository");
    try {
      await git(null, ["init", "--initial-branch=main", repositoryPath]);
      await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
      await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "external lane blocked\n", "utf8");
      await git(repositoryPath, ["add", "artifact.txt"]);
      await git(repositoryPath, ["commit", "-m", "external integration precondition"]);
      const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
      const closeState = stateFor(repositoryPath, commitSha, new Date().toISOString(), "origin", "refs/heads/main");
      const verdict = await closeTask(closeState, {
        store: storeFor(closeState),
        gitHub: GitHubCliAdapter.create({ mode: "external", enterpriseHost: null, credentialsConfigured: false }),
      });

      expect(verdict.status).toBe("BLOCKED");
      expect(verdict.reasons.join(" ")).toMatch(/credentials|configuration/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
