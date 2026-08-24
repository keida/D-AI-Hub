import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { GitHubCliAdapter, GitRemoteBlockedError } from "../../src/adapters/github.js";
import { pushGitRef, readRemoteRef, type GitPushResult, type GitTransport } from "../../src/adapters/git.js";
import { closeTask } from "../../src/close/close-service.js";
import { TaskOwnershipError } from "../../src/domain/errors.js";
import type { CloseCandidate, CloseVerdict, DurableContextManifest, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import type { DurableContextStore, TaskOwnershipLease } from "../../src/state/durable-context-store.js";
import type { GitHubAdapter, GitPushEvidence, RemoteState } from "../../src/adapters/github.js";
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
      "branch:main",
      `remote:${remote}`,
      `ref:${ref}`,
      "local-state:clean-required",
      `artifact:commit:${commitSha}`,
      "remote-repository:github.com/acme/d-ai",
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

interface RealCloseFixture {
  readonly store: FileDurableContextStore;
  readonly state: TaskState;
  readonly commitSha: string;
}

async function createRealCloseFixture(
  durableContextRoot: string,
  repositoryPath: string,
  commitSha: string,
  now: string,
  remote: string,
  ref: string,
): Promise<RealCloseFixture> {
  const store = new FileDurableContextStore(durableContextRoot);
  const initial = stateFor(repositoryPath, commitSha, now, remote, ref);
  const baseState: TaskState = {
    ...initial,
    verificationEvidence: verificationEvidence(now).map((item) => ({ ...item, recoveryPointId: null })),
    recoveryPoint: null,
    durableContext: null,
  };
  const snapshotManifest = await store.createIfAbsent(baseState);
  const verifiedState: TaskState = {
    ...baseState,
    verificationEvidence: verificationEvidence(now),
    recoveryPoint: {
      recoveryPointId: "recovery-integration",
      taskId: baseState.taskId,
      stage: baseState.stage,
      environment: baseState.environment,
      role: baseState.role,
      durablePaths: snapshotManifest.durablePaths,
      hashes: snapshotManifest.hashes,
      restorationInstructions: "Restore the recorded recovery state without deleting user work.",
      createdAt: now,
      snapshotManifestId: snapshotManifest.manifestId,
    },
  };
  await store.withTaskOwnership(verifiedState.taskId, verifiedState.environment, async (lease) => {
    await store.save(verifiedState, lease);
  });
  const state = await store.load(verifiedState.taskId);
  if (state === null) throw new Error("Expected the real durable close fixture to load");
  return { store, state, commitSha };
}

interface BareCloseFixture {
  readonly root: string;
  readonly repositoryPath: string;
  readonly bareRemotePath: string;
  readonly close: RealCloseFixture;
}

async function createBareCloseFixture(prefix: string): Promise<BareCloseFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repositoryPath = join(root, "repository");
  const bareRemotePath = join(root, "remote.git");
  await git(null, ["init", "--bare", bareRemotePath]);
  await git(null, ["init", "--initial-branch=main", repositoryPath]);
  await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
  await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
  await writeFile(join(repositoryPath, "artifact.txt"), "verified artifact\n", "utf8");
  await git(repositoryPath, ["add", "artifact.txt"]);
  await git(repositoryPath, ["commit", "-m", "integration artifact"]);
  const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
  await git(repositoryPath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
  const close = await createRealCloseFixture(join(root, "durable"), repositoryPath, commitSha, new Date().toISOString(), "origin", "refs/heads/main");
  return { root, repositoryPath, bareRemotePath, close };
}

function storeFor(state: TaskState): DurableContextStore {
  let closeCandidate: CloseCandidate | null = null;
  return {
    load: async (): Promise<TaskState> => state,
    save: async (): Promise<DurableContextManifest> => {
      throw new Error("Close integration must not save durable context");
    },
    saveCloseCandidate: async (candidate: CloseCandidate): Promise<void> => {
      closeCandidate = candidate;
    },
    loadCloseCandidate: async (): Promise<CloseCandidate | null> => closeCandidate,
    recordCriticalUnsavedContext: async (): Promise<void> => {
      throw new Error("Close integration must not record unsaved context");
    },
    clearCriticalUnsavedContext: async (): Promise<void> => {
      throw new Error("Close integration must not clear unsaved context");
    },
  };
}

async function closeWithOwnership(
  state: TaskState,
  dependencies: { readonly store: DurableContextStore; readonly gitHub: GitHubAdapter },
): Promise<CloseVerdict> {
  if (dependencies.store.withTaskOwnership === undefined) {
    const lease: TaskOwnershipLease = { taskId: state.taskId, environment: state.environment, generation: 1n, ownerToken: "00000000-0000-4000-8000-000000000001" };
    return closeTask(state, dependencies, lease, async (): Promise<void> => {});
  }
  return dependencies.store.withTaskOwnership(
    state.taskId,
    state.environment,
    async (lease, _transfer, assertOwnership) => closeTask(state, dependencies, lease, assertOwnership),
  );
}

describe("GitHub close integration", () => {
  it("does not push after ownership is lost following close-candidate persistence", async () => {
    const now = new Date().toISOString();
    const state = stateFor("C:/workspace", "e".repeat(40), now, "origin", "refs/heads/main");
    const baseStore = storeFor(state);
    let ownershipLost = false;
    let pushCalls = 0;
    let remoteCalls = 0;
    const store: DurableContextStore = {
      ...baseStore,
      saveCloseCandidate: async (candidate: CloseCandidate): Promise<void> => {
        await baseStore.saveCloseCandidate!(candidate);
        ownershipLost = true;
      },
    };
    const gitHub: GitHubAdapter = {
      pushExpectedCommit: async (): Promise<GitPushEvidence> => {
        pushCalls += 1;
        throw new Error("Push must not run after ownership loss");
      },
      verifyRemoteState: async (): Promise<RemoteState> => {
        remoteCalls += 1;
        throw new Error("Remote verification must not run after ownership loss");
      },
    };
    const lease: TaskOwnershipLease = { taskId: state.taskId, environment: state.environment, generation: 1n, ownerToken: "00000000-0000-4000-8000-000000000001" };
    const assertOwnership = async (): Promise<void> => {
      if (ownershipLost) throw new TaskOwnershipError("Close ownership was lost");
    };
    const verdict = await closeTask(state, { store, gitHub }, lease, assertOwnership);

    expect(verdict.status).toBe("BLOCKED");
    expect(pushCalls).toBe(0);
    expect(remoteCalls).toBe(0);
  });

  it("does not verify the remote after ownership is lost during push", async () => {
    const now = new Date().toISOString();
    const state = stateFor("C:/workspace", "e".repeat(40), now, "origin", "refs/heads/main");
    let ownershipLost = false;
    let remoteCalls = 0;
    const gitHub: GitHubAdapter = {
      pushExpectedCommit: async (): Promise<GitPushEvidence> => {
        ownershipLost = true;
        return {
          remote: "origin",
          repository: "github.com/acme/d-ai",
          ref: "refs/heads/main",
          localSha: "e".repeat(40),
          pushed: true,
          observedOutput: "Push completed",
          exitCode: 0,
          failureCategory: null,
        };
      },
      verifyRemoteState: async (): Promise<RemoteState> => {
        remoteCalls += 1;
        return { repository: "github.com/acme/d-ai", ref: "refs/heads/main", remoteSha: "e".repeat(40), matchesExpectedSha: true };
      },
    };
    const lease: TaskOwnershipLease = { taskId: state.taskId, environment: state.environment, generation: 1n, ownerToken: "00000000-0000-4000-8000-000000000001" };
    const assertOwnership = async (): Promise<void> => {
      if (ownershipLost) throw new TaskOwnershipError("Close ownership was lost");
    };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub }, lease, assertOwnership);

    expect(verdict.status).toBe("BLOCKED");
    expect(remoteCalls).toBe(0);
  });

  it("pushes to a temporary bare remote and verifies its exact SHA through the GitHub adapter", async () => {
    const fixture = await createBareCloseFixture("d-ai-github-close-");
    const { root, repositoryPath, bareRemotePath, close } = fixture;
    try {
      const candidatePath = join(root, "durable", close.state.taskId, "close-candidate.json");
      let pushResult: GitPushResult | null = null;
      const localBareTransport: GitTransport = {
        pushRef: async (localRepositoryPath, _endpoint, ref, head) => {
          const candidateRecord = JSON.parse(await readFile(candidatePath, "utf8")) as { candidate: { taskId: string; durableContext: { hashes: Readonly<Record<string, string>> }; commitSha: string }; hash: string };
          expect(candidateRecord.candidate.taskId).toBe(close.state.taskId);
          expect(candidateRecord.candidate.commitSha).toBe(close.commitSha);
          expect(candidateRecord.candidate.durableContext.hashes).toEqual(close.state.durableContext?.hashes);
          expect(candidateRecord.hash).toMatch(/^[a-f0-9]{64}$/);
          pushResult = await pushGitRef(localRepositoryPath, bareRemotePath, ref, head);
          return pushResult;
        },
        readRef: async (_localRepositoryPath, _endpoint, ref) => readRemoteRef(bareRemotePath, ref, null),
      };

      const verdict = await closeWithOwnership(close.state, {
        store: close.store,
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, localBareTransport),
      });

      expect(verdict).toMatchObject({ status: "YES", reasons: [] });
      expect(pushResult).toMatchObject({ pushed: true, exitCode: 0 });
      expect(await git(bareRemotePath, ["rev-parse", "refs/heads/main"])).toBe(close.commitSha);
      expect(await close.store.loadCloseCandidate(close.state.taskId)).toEqual(verdict.closeCandidate);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks YES when the real durable close candidate is mutated after push", async () => {
    const fixture = await createBareCloseFixture("d-ai-github-candidate-mutation-");
    try {
      const candidatePath = join(fixture.root, "durable", fixture.close.state.taskId, "close-candidate.json");
      const localBareTransport: GitTransport = {
        pushRef: async (localRepositoryPath, _endpoint, ref, head) => {
          const result = await pushGitRef(localRepositoryPath, fixture.bareRemotePath, ref, head);
          const candidateRecord = JSON.parse(await readFile(candidatePath, "utf8")) as { candidate: { ref: string }; hash: string };
          await writeFile(candidatePath, `${JSON.stringify({ candidate: { ...candidateRecord.candidate, ref: "refs/heads/other" }, hash: candidateRecord.hash }, null, 2)}\n`, "utf8");
          return result;
        },
        readRef: async (_localRepositoryPath, _endpoint, ref) => readRemoteRef(fixture.bareRemotePath, ref, null),
      };
      const verdict = await closeWithOwnership(fixture.close.state, {
        store: fixture.close.store,
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, localBareTransport),
      });

      expect(verdict.status).toBe("BLOCKED");
      expect(await git(fixture.bareRemotePath, ["rev-parse", "refs/heads/main"])).toBe(fixture.close.commitSha);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns NO when critical unsaved context appears after the real candidate is persisted", async () => {
    const fixture = await createBareCloseFixture("d-ai-github-unsaved-context-");
    try {
      const verdict = await fixture.close.store.withTaskOwnership(fixture.close.state.taskId, fixture.close.state.environment, async (lease, _transfer, assertOwnership) => {
        const localBareTransport: GitTransport = {
          pushRef: async (localRepositoryPath, _endpoint, ref, head) => {
            const result = await pushGitRef(localRepositoryPath, fixture.bareRemotePath, ref, head);
            await fixture.close.store.recordCriticalUnsavedContext(fixture.close.state.taskId, ["late unsaved context"], lease);
            return result;
          },
          readRef: async (_localRepositoryPath, _endpoint, ref) => readRemoteRef(fixture.bareRemotePath, ref, null),
        };
        return closeTask(fixture.close.state, {
          store: fixture.close.store,
          gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, localBareTransport),
        }, lease, assertOwnership);
      });

      expect(verdict.status).toBe("NO");
      expect(await git(fixture.bareRemotePath, ["rev-parse", "refs/heads/main"])).toBe(fixture.close.commitSha);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns NO when real durable task context changes after remote verification", async () => {
    const fixture = await createBareCloseFixture("d-ai-github-post-candidate-change-");
    try {
      const verdict = await fixture.close.store.withTaskOwnership(fixture.close.state.taskId, fixture.close.state.environment, async (lease, _transfer, assertOwnership) => {
        const localBareTransport: GitTransport = {
          pushRef: async (localRepositoryPath, _endpoint, ref, head) => pushGitRef(localRepositoryPath, fixture.bareRemotePath, ref, head),
          readRef: async (_localRepositoryPath, _endpoint, ref) => {
            const remoteState = await readRemoteRef(fixture.bareRemotePath, ref, null);
            const current = await fixture.close.store.load(fixture.close.state.taskId);
            if (current === null) throw new Error("Expected durable state during remote verification");
            await fixture.close.store.save({ ...current, contextManifest: [...current.contextManifest, "post-candidate-change"] }, lease);
            return remoteState;
          },
        };
        return closeTask(fixture.close.state, {
          store: fixture.close.store,
          gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, localBareTransport),
        }, lease, assertOwnership);
      });

      expect(verdict.status).toBe("NO");
      expect(await git(fixture.bareRemotePath, ["rev-parse", "refs/heads/main"])).toBe(fixture.close.commitSha);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
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
      const verdict = await closeWithOwnership(closeState, {
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
      const verdict = await closeWithOwnership(closeState, {
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
      const verdict = await closeWithOwnership(closeState, {
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
      const verdict = await closeWithOwnership(closeState, {
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
      const verdict = await closeWithOwnership(closeState, {
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
      const verdict = await closeWithOwnership(closeState, {
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
