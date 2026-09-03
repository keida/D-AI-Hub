import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { GitHubCliAdapter } from "../../src/adapters/github.js";
import { pushGitRef, readRemoteRef, type GitTransport } from "../../src/adapters/git.js";
import type { Environment, TaskState, VerificationEvidence } from "../../src/domain/types.js";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import { FileHandoffPersistence } from "../../src/handoff/handoff-service.js";
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
      "branch:main",
      "remote:origin",
      "ref:refs/heads/main",
      "local-state:clean-required",
      `artifact:commit:${commitSha}`,
      "remote-repository:github.com/acme/d-ai",
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
  it.each(["chat", "work"] as const)("fails closed before ownership transfer when default %s activation is unavailable", async (target) => {
    const fixture = await createActivationFixture(`d-ai-codex-handoff-${target}-`);
    try {
      const store = new FileDurableContextStore(fixture.durableRoot);
      await store.withTaskOwnership(fixture.state.taskId, "codex", async (lease) => {
        await store.save({ ...fixture.state, handoffState: "none" }, lease);
      });
      const activate = createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }));

      const result = await activate({ rawCommand: `@D-AI handoff ${target}`, taskId: fixture.state.taskId });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, environment: "codex", status: "blocked" });
      expect(result.message).toMatch(/activation|connector|receive/i);
      await expect(store.load(fixture.state.taskId)).resolves.toMatchObject({ environment: "codex", handoffState: "none" });
      await expect(new FileHandoffPersistence(join(fixture.durableRoot, "handoffs.json")).load()).resolves.toEqual([]);
      const freshStatus = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: null });
      expect(freshStatus).toMatchObject({ taskId: fixture.state.taskId, environment: "codex", status: "accepted" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

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

  it("continues the unique active durable task from a natural-language project name", async () => {
    const fixture = await createActivationFixture("d-ai-codex-project-continue-");
    try {
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "继续 d-ai", taskId: null });

      expect(result).toMatchObject({
        taskId: fixture.state.taskId,
        status: "accepted",
        message: `Continuing task ${fixture.state.taskId}`,
        userIntent: { intent: "continue", project: "d-ai" },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for a multi-word unknown project without throwing", async () => {
    const fixture = await createActivationFixture("d-ai-codex-project-unknown-words-");
    try {
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "继续 Unknown Project", taskId: null });

      expect(result).toMatchObject({ taskId: "unassigned", status: "blocked" });
      expect(result.message).toBe("No active durable task found for project Unknown Project");
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

  it("keeps identity facts unique across fresh status and normal close discovery", async () => {
    const fixture = await createActivationFixture("d-ai-codex-fresh-close-idempotence-");
    try {
      const commitSha = fixture.state.contextManifest.find((entry) => entry.startsWith("artifact:commit:"))?.slice("artifact:commit:".length);
      if (commitSha === undefined) throw new Error("Expected the fixture commit identity");
      let pushCalls = 0;
      let readCalls = 0;
      const transport: GitTransport = {
        pushRef: async () => {
          pushCalls += 1;
          return { pushed: true, observedOutput: "Push completed", exitCode: 0, failureCategory: null };
        },
        readRef: async (_repositoryPath, _endpoint, ref) => {
          readCalls += 1;
          return { command: "git", arguments: ["ls-remote", ref], stdout: `${commitSha}\t${ref}\n`, stderr: "", exitCode: 0 };
        },
      };
      const firstGitHub = GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, transport);
      const firstRuntime = createConfiguredDAIRuntime({ workspacePath: fixture.repositoryPath, durableRoot: fixture.durableRoot, gitHub: firstGitHub });
      const firstStatus = await createCodexActivation(firstRuntime)({ rawCommand: "@D-AI status", taskId: null });
      expect(firstStatus).toMatchObject({ taskId: fixture.state.taskId, status: "accepted", stage: "verify" });

      const freshGitHub = GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, transport);
      const freshRuntime = createConfiguredDAIRuntime({ workspacePath: fixture.repositoryPath, durableRoot: fixture.durableRoot, gitHub: freshGitHub });
      const repeatedStatus = await createCodexActivation(freshRuntime)({ rawCommand: "@D-AI status", taskId: null });
      expect(repeatedStatus).toMatchObject({ taskId: fixture.state.taskId, status: "accepted", stage: "verify" });
      const beforeClose = await new FileDurableContextStore(fixture.durableRoot).load(fixture.state.taskId);
      if (beforeClose === null) throw new Error("Expected the durable task before close");
      for (const prefix of ["branch:", "remote:", "ref:", "artifact:commit:", "local-state:", "remote-repository:"]) {
        expect(beforeClose.contextManifest.filter((entry) => entry.startsWith(prefix))).toHaveLength(1);
      }

      const closed = await createCodexActivation(freshRuntime)({ rawCommand: "@D-AI close", taskId: null });
      expect(closed).toMatchObject({ taskId: fixture.state.taskId, status: "completed", stage: "close" });
      expect(closed.message).toMatch(/YES/i);
      expect(pushCalls).toBe(1);
      expect(readCalls).toBe(1);
      const afterClose = await new FileDurableContextStore(fixture.durableRoot).load(fixture.state.taskId);
      if (afterClose === null) throw new Error("Expected the durable task after close");
      for (const prefix of ["branch:", "remote:", "ref:", "artifact:commit:", "local-state:", "remote-repository:"]) {
        expect(afterClose.contextManifest.filter((entry) => entry.startsWith(prefix))).toHaveLength(1);
      }

      const finalRuntime = createConfiguredDAIRuntime({
        workspacePath: fixture.repositoryPath,
        durableRoot: fixture.durableRoot,
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: null }, transport),
      });
      await expect(createCodexActivation(finalRuntime)({ rawCommand: "@D-AI close", taskId: null })).resolves.toMatchObject({ taskId: "unassigned", status: "blocked" });
      expect(pushCalls).toBe(1);
      expect(readCalls).toBe(1);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves a nested workspace through production recovery capture and rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-nested-rollback-"));
    const repositoryRoot = join(root, "repository");
    const workspacePath = join(repositoryRoot, "packages", "app");
    const durableRoot = join(workspacePath, ".d-ai");
    const skillPath = join(workspacePath, ".agents", "skills", "verify-local");
    try {
      await mkdir(skillPath, { recursive: true });
      await writeFile(join(skillPath, "SKILL.md"), `---\nname: verify-local\ndescription: Bounded local verification\nmetadata:\n  triggers: '["verify"]'\n  compatibleEnvironments: '["codex"]'\n  compatibleStages: '["execute"]'\n---\n\n# Bounded local verification\n`, "utf8");
      await writeFile(join(workspacePath, "artifact.txt"), "known good\n", "utf8");
      await git(null, ["init", "--initial-branch=main", repositoryRoot]);
      await git(repositoryRoot, ["config", "user.email", "d-ai@example.test"]);
      await git(repositoryRoot, ["config", "user.name", "D-AI Test"]);
      await git(repositoryRoot, ["add", "packages/app"]);
      await git(repositoryRoot, ["commit", "-m", "test: nested recovery baseline"]);
      await git(repositoryRoot, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);

      const runtime = createConfiguredDAIRuntime({ workspacePath });
      const activate = createCodexActivation(runtime);
      const executed = await activate({ rawCommand: "@D-AI verify nested workspace", taskId: null });
      expect(executed.status).toBe("completed");
      const beforeRollback = await new FileDurableContextStore(durableRoot).load(executed.taskId);
      expect(beforeRollback?.recoverySnapshot?.workspacePath).toBe(await realpath(workspacePath));

      await writeFile(join(workspacePath, "artifact.txt"), "regression\n", "utf8");
      await git(repositoryRoot, ["add", "packages/app/artifact.txt"]);
      await git(repositoryRoot, ["commit", "-m", "test: nested regression"]);
      await writeFile(join(workspacePath, "user-work.txt"), "preserve me\n", "utf8");

      const rolledBack = await activate({ rawCommand: "@D-AI rollback", taskId: executed.taskId });
      const recoveryHead = beforeRollback?.recoverySnapshot?.head;
      if (recoveryHead === undefined) throw new Error("Expected recovery head");
      await expect(git(repositoryRoot, ["diff", "--name-status", recoveryHead, "HEAD"])).resolves.toBe("");
      expect(rolledBack.message).toMatch(/rollback restored/i);
      const afterRollback = await new FileDurableContextStore(durableRoot).load(executed.taskId);
      expect(afterRollback?.recoverySnapshot?.workspacePath).toBe(await realpath(workspacePath));
      expect(afterRollback?.rollbackAudit?.verification.passed).toBe(true);
      await expect(git(repositoryRoot, ["show", "HEAD:packages/app/artifact.txt"])).resolves.toBe("known good");
      await expect(git(repositoryRoot, ["stash", "list"])).resolves.toMatch(/d-ai-rollback-/);
    } finally {
      await rm(root, { recursive: true, force: true });
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

  it.skipIf(process.platform !== "win32")("treats a case-variant workspace path as the same Windows workspace", async () => {
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

  it.skipIf(process.platform !== "linux")("rejects a case-variant workspace path on a case-sensitive Linux filesystem", async () => {
    const fixture = await createActivationFixture("d-ai-codex-case-sensitive-workspace-");
    try {
      const caseVariantWorkspace = fixture.repositoryPath.replace(/[a-z]/g, (character) => character.toUpperCase());
      const result = await createCodexActivation(createConfiguredDAIRuntime({
        workspacePath: caseVariantWorkspace,
        durableRoot: fixture.durableRoot,
      }))({ rawCommand: "@D-AI status", taskId: fixture.state.taskId });

      expect(result).toMatchObject({ taskId: fixture.state.taskId, status: "blocked" });
      expect(result.message).toMatch(/different workspace/i);
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

  it("honors an explicit Enterprise GitHub host through Codex bootstrap, execution, recovery, and close", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-enterprise-host-"));
    const workspacePath = join(root, "workspace");
    const durableRoot = join(workspacePath, ".d-ai");
    const bareRemotePath = join(root, "remote.git");
    const verificationSkillPath = join(workspacePath, ".agents", "skills", "verify-local");
    const previousEnterpriseHost = process.env.D_AI_GITHUB_EXTERNAL_ENTERPRISE_HOST;
    try {
      process.env.D_AI_GITHUB_EXTERNAL_ENTERPRISE_HOST = "wrong.example.test";
      await mkdir(verificationSkillPath, { recursive: true });
      await writeFile(join(verificationSkillPath, "SKILL.md"), `---\nname: verify-local\ndescription: Bounded local verification\nmetadata:\n  triggers: '["verify"]'\n  compatibleEnvironments: '["codex"]'\n  compatibleStages: '["execute"]'\n---\n\n# Bounded local verification\n`, "utf8");
      await writeFile(join(workspacePath, "artifact.txt"), "enterprise artifact\n", "utf8");
      await git(null, ["init", "--bare", bareRemotePath]);
      await git(workspacePath, ["init", "--initial-branch=main"]);
      await git(workspacePath, ["config", "user.email", "d-ai@example.test"]);
      await git(workspacePath, ["config", "user.name", "D-AI Test"]);
      await git(workspacePath, ["add", "."]);
      await git(workspacePath, ["commit", "-m", "enterprise verification fixture"]);
      await git(workspacePath, ["remote", "add", "origin", "https://git.example.test/acme/d-ai.git"]);
      const transport: GitTransport = {
        pushRef: async (localRepositoryPath, _endpoint, ref, head) => pushGitRef(localRepositoryPath, bareRemotePath, ref, head),
        readRef: async (_localRepositoryPath, _endpoint, ref) => readRemoteRef(bareRemotePath, ref, null),
      };
      const runtime = createConfiguredDAIRuntime({
        workspacePath,
        durableRoot,
        githubEnterpriseHost: "git.example.test",
        gitHub: GitHubCliAdapter.forTestTransport({ mode: "test", enterpriseHost: "git.example.test" }, transport),
      });
      const activate = createCodexActivation(runtime);

      const verified = await activate({ rawCommand: "@D-AI verify Enterprise workspace", taskId: null });
      expect(verified).toMatchObject({ environment: "codex", status: "completed", stage: "verify" });
      expect(verified.message).toMatch(/verification/i);
      const task = await new FileDurableContextStore(durableRoot).load(verified.taskId);
      expect(task?.contextManifest).toContain("remote-repository:git.example.test/acme/d-ai");
      expect(task?.recoveryPoint).not.toBeNull();

      const closed = await activate({ rawCommand: "@D-AI close", taskId: verified.taskId });
      expect(closed).toMatchObject({ taskId: verified.taskId, environment: "codex", status: "completed", stage: "close" });
      expect(closed.message).toMatch(/YES/i);
      await expect(git(bareRemotePath, ["rev-parse", "refs/heads/main"])).resolves.toMatch(/^[a-f0-9]{40}$/);
    } finally {
      if (previousEnterpriseHost === undefined) delete process.env.D_AI_GITHUB_EXTERNAL_ENTERPRISE_HOST;
      else process.env.D_AI_GITHUB_EXTERNAL_ENTERPRISE_HOST = previousEnterpriseHost;
      await rm(root, { recursive: true, force: true });
    }
  });
});
