import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { GitHubCliAdapter } from "../../src/adapters/github.js";
import type { GitTransport } from "../../src/adapters/git.js";
import type { Environment, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { createConfiguredDAIRuntime } from "../../src/runtime/d-ai-runtime.js";
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

async function git(cwd: string | null, arguments_: readonly string[]): Promise<string> {
  return (await runCommand({ command: "git", arguments: arguments_, cwd })).stdout.trim();
}

function evidence(now: string, recoveryPointId: string | null): readonly VerificationEvidence[] {
  return gateNames.map((gate) => ({
    evidenceId: `gate:${gate}`,
    stage: "verify",
    environment: "codex",
    role: "evidence-collector",
    selectedModel: "codex-entry-acceptance",
    command: `verify ${gate}`,
    observedOutput: `${gate} passed`,
    exitCode: 0,
    interpretation: `${gate} was directly verified`,
    passed: true,
    recoveryPointId,
    recordedAt: now,
  }));
}

async function seedCloseReadyTask(
  durableRoot: string,
  repositoryPath: string,
  commitSha: string,
  now: string,
  taskId = "task-codex-entry-close",
  environment: Environment = "codex",
): Promise<{ readonly store: FileDurableContextStore; readonly state: TaskState }> {
  const store = new FileDurableContextStore(durableRoot);
  const baseState: TaskState = {
    taskId,
    goal: "Verify the Codex activation close boundary",
    constraints: ["No destructive cleanup"],
    environment,
    stage: "verify",
    role: "evidence-collector",
    routingDecision: {
      stage: "verify",
      environment: "codex",
      role: "evidence-collector",
      selectedModel: "codex-entry-acceptance",
      selectedCapabilities: ["codex-evidence"],
      reason: "Exercise the configured Codex close entry",
      overrideSource: "default",
    },
    selectedCapabilities: ["codex-evidence"],
    contextManifest: [
      `identity:workspace:${repositoryPath}:${createHash("sha256").update(repositoryPath, "utf8").digest("hex")}`,
      `identity:repository:${repositoryPath}:${createHash("sha256").update(repositoryPath, "utf8").digest("hex")}`,
      "remote:origin",
      "ref:refs/heads/main",
      "local-state:clean-required",
      `artifact:commit:${commitSha}`,
    ],
    handoffState: "completed",
    verificationEvidence: evidence(now, null),
    recoveryPoint: null,
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext: null,
  };
  const snapshot = await store.createIfAbsent(baseState);
  const recoveryPointId = "recovery-codex-entry-close";
  const verifiedState: TaskState = {
    ...baseState,
    verificationEvidence: evidence(now, recoveryPointId),
    recoveryPoint: {
      recoveryPointId,
      taskId,
      stage: "verify",
      environment,
      role: "evidence-collector",
      durablePaths: snapshot.durablePaths,
      hashes: snapshot.hashes,
      restorationInstructions: "Restore the recorded durable task generation.",
      createdAt: now,
      snapshotManifestId: snapshot.manifestId,
    },
  };
  await store.withTaskOwnership(taskId, environment, async (lease) => {
    await store.save(verifiedState, lease);
  });
  const state = await store.load(taskId);
  if (state === null) throw new Error("Expected the close-ready durable task to load");
  return { store, state };
}

async function createActivationFixture(prefix: string): Promise<{
  readonly root: string;
  readonly repositoryPath: string;
  readonly durableRoot: string;
  readonly state: TaskState;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const repositoryPath = join(root, "repository");
  const durableRoot = join(root, "durable");
  await mkdir(repositoryPath);
  await git(null, ["init", "--initial-branch=main", repositoryPath]);
  await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
  await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
  await writeFile(join(repositoryPath, "artifact.txt"), "verified artifact\n", "utf8");
  await git(repositoryPath, ["add", "artifact.txt"]);
  await git(repositoryPath, ["commit", "-m", "verified artifact"]);
  const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
  await git(repositoryPath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
  const { state } = await seedCloseReadyTask(durableRoot, repositoryPath, commitSha, new Date().toISOString());
  return { root, repositoryPath, durableRoot, state };
}

describe("Codex activation close acceptance", { timeout: 20_000 }, () => {
  it("returns NO when the configured remote reports a different SHA", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-close-mismatch-"));
    const repositoryPath = join(root, "repository");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(repositoryPath);
      await git(null, ["init", "--initial-branch=main", repositoryPath]);
      await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
      await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "verified artifact\n", "utf8");
      await git(repositoryPath, ["add", "artifact.txt"]);
      await git(repositoryPath, ["commit", "-m", "verified artifact"]);
      const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
      await git(repositoryPath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
      const { state } = await seedCloseReadyTask(durableRoot, repositoryPath, commitSha, new Date().toISOString());
      const transport: GitTransport = {
        pushRef: async () => ({ pushed: true, observedOutput: "Push completed", exitCode: 0, failureCategory: null }),
        readRef: async (_repositoryPath, endpoint, ref) => ({
          command: "git",
          arguments: ["ls-remote", endpoint, ref],
          stdout: `${"f".repeat(40)}\t${ref}\n`,
          stderr: "",
          exitCode: 0,
        }),
      };
      const runtime = createConfiguredDAIRuntime({
        workspacePath: repositoryPath,
        durableRoot,
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, transport),
      });
      const activate = createCodexActivation(runtime);

      const result = await activate({ rawCommand: "@D-AI close", taskId: state.taskId });

      expect(result.status).toBe("blocked");
      expect(result.message).toMatch(/Close verdict NO.*Remote SHA does not match/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns NO for a dirty worktree without calling the push transport", async () => {
    const fixture = await createActivationFixture("d-ai-codex-close-dirty-");
    try {
      await writeFile(join(fixture.repositoryPath, "dirty.txt"), "unsaved work\n", "utf8");
      const transport: GitTransport = {
        pushRef: async () => { throw new Error("Dirty close must not push"); },
        readRef: async () => { throw new Error("Dirty close must not verify a remote"); },
      };
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, transport),
      }));

      const result = await activate({ rawCommand: "@D-AI close", taskId: fixture.state.taskId });

      expect(result.status).toBe("blocked");
      expect(result.message).toMatch(/Close verdict NO.*worktree is not clean/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("returns BLOCKED when GitHub credentials are not configured", async () => {
    const fixture = await createActivationFixture("d-ai-codex-close-unconfigured-");
    try {
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
        githubCredentialsConfigured: false,
      }));

      const result = await activate({ rawCommand: "@D-AI close", taskId: fixture.state.taskId });

      expect(result.status).toBe("blocked");
      expect(result.message).toMatch(/Close verdict BLOCKED.*credentials.*configuration/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("auto-selects the unique active workspace task for fresh status", async () => {
    const fixture = await createActivationFixture("d-ai-codex-status-discovery-");
    try {
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: null });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, status: "accepted", stage: "verify" });
      expect(result.message).toContain(fixture.state.taskId);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("auto-selects the unique active workspace task before close verification", async () => {
    const fixture = await createActivationFixture("d-ai-codex-close-discovery-");
    try {
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
        githubCredentialsConfigured: false,
      }))({ rawCommand: "@D-AI close", taskId: null });

      expect(result.taskId).toBe(fixture.state.taskId);
      expect(result.message).toMatch(/Close verdict BLOCKED.*credentials/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks ambiguous workspace discovery and lists only safe candidate task ids", async () => {
    const fixture = await createActivationFixture("d-ai-codex-discovery-ambiguous-");
    try {
      await seedCloseReadyTask(
        fixture.durableRoot,
        fixture.repositoryPath,
        await git(fixture.repositoryPath, ["rev-parse", "HEAD"]),
        new Date().toISOString(),
        "task-codex-entry-second",
      );
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: null });

      expect(result).toMatchObject({ taskId: "ambiguous", status: "blocked" });
      expect(result.message).toContain("task-codex-entry-close");
      expect(result.message).toContain("task-codex-entry-second");
      expect(result.message).toContain("--task <task-id>");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks explicit selection when the configured workspace differs", async () => {
    const fixture = await createActivationFixture("d-ai-codex-workspace-mismatch-");
    const otherWorkspace = join(fixture.root, "other-workspace");
    try {
      await mkdir(otherWorkspace);
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: otherWorkspace,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: fixture.state.taskId });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, status: "blocked" });
      expect(result.message).toMatch(/different workspace/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats a junction to the canonical workspace as the same explicit workspace", async () => {
    const fixture = await createActivationFixture("d-ai-codex-junction-workspace-");
    const workspaceLink = join(fixture.root, "workspace-link");
    try {
      await symlink(fixture.repositoryPath, workspaceLink, "junction");
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: workspaceLink,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: fixture.state.taskId });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, status: "accepted" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("treats a case-variant workspace path as the same Windows workspace", async () => {
    const fixture = await createActivationFixture("d-ai-codex-case-workspace-");
    try {
      const caseVariantWorkspace = fixture.repositoryPath.replace(/[a-z]/g, (character) => character.toUpperCase());
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: caseVariantWorkspace,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: fixture.state.taskId });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, status: "accepted" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks explicit selection when durable state has no canonical workspace identity", async () => {
    const fixture = await createActivationFixture("d-ai-codex-missing-workspace-identity-");
    try {
      const store = new FileDurableContextStore(fixture.durableRoot);
      const state = await store.load(fixture.state.taskId);
      if (state === null) throw new Error("Expected the fixture task to load");
      await store.withTaskOwnership(fixture.state.taskId, "codex", async (lease) => {
        await store.save({
          ...state,
          contextManifest: state.contextManifest.filter((entry) => !entry.startsWith("identity:workspace:")),
        }, lease);
      });

      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: fixture.state.taskId });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, status: "blocked" });
      expect(result.message).toMatch(/different workspace/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks discovery when durable state contains duplicate workspace identities", async () => {
    const fixture = await createActivationFixture("d-ai-codex-duplicate-workspace-identity-");
    try {
      const store = new FileDurableContextStore(fixture.durableRoot);
      const state = await store.load(fixture.state.taskId);
      if (state === null) throw new Error("Expected the fixture task to load");
      const workspaceIdentity = state.contextManifest.find((entry) => entry.startsWith("identity:workspace:"));
      if (workspaceIdentity === undefined) throw new Error("Expected the fixture workspace identity");
      await store.withTaskOwnership(fixture.state.taskId, "codex", async (lease) => {
        await store.save({ ...state, contextManifest: [...state.contextManifest, workspaceIdentity] }, lease);
      });

      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: null });

      expect(result).toMatchObject({ taskId: "unassigned", status: "blocked" });
      expect(result.message).toMatch(/No active D-AI task matches this workspace/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks explicit selection of a closed task", async () => {
    const fixture = await createActivationFixture("d-ai-codex-closed-task-selection-");
    try {
      const store = new FileDurableContextStore(fixture.durableRoot);
      const state = await store.load(fixture.state.taskId);
      if (state === null) throw new Error("Expected the fixture task to load");
      await store.withTaskOwnership(fixture.state.taskId, "codex", async (lease) => {
        await store.save({ ...state, stage: "close" }, lease);
      });

      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: fixture.state.taskId });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, status: "blocked", stage: "close" });
      expect(result.message).toMatch(/not active.*current stage is close/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("blocks discovered tasks owned by another environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-ownership-discovery-"));
    const repositoryPath = join(root, "repository");
    const durableRoot = join(root, "durable");
    try {
      await mkdir(repositoryPath);
      await git(null, ["init", "--initial-branch=main", repositoryPath]);
      await git(repositoryPath, ["config", "user.email", "d-ai@example.test"]);
      await git(repositoryPath, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "verified artifact\n", "utf8");
      await git(repositoryPath, ["add", "artifact.txt"]);
      await git(repositoryPath, ["commit", "-m", "verified artifact"]);
      const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
      const { state } = await seedCloseReadyTask(durableRoot, repositoryPath, commitSha, new Date().toISOString(), "task-work-owned", "work");
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: repositoryPath,
        durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: null });

      expect(result).toMatchObject({ taskId: state.taskId, status: "blocked", environment: "work" });
      expect(result.message).toMatch(/owned by work/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not select a task from another workspace when the durable root is shared", async () => {
    const fixture = await createActivationFixture("d-ai-codex-unrelated-workspace-");
    const unrelatedWorkspace = join(fixture.root, "unrelated");
    try {
      await mkdir(unrelatedWorkspace);
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: unrelatedWorkspace,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: null });

      expect(result).toMatchObject({ taskId: "unassigned", status: "blocked" });
      expect(result.message).toMatch(/No active D-AI task matches this workspace/i);
      expect(result.message).not.toContain(fixture.state.taskId);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
