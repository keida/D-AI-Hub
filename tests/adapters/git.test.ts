import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { inspectCurrentGitState, inspectLocalGitState, isValidGitBranchName, isValidGitTargetRef } from "../../src/adapters/git.js";

async function git(cwd: string | null, argumentsList: readonly string[]): Promise<void> {
  await runCommand({ command: "git", arguments: argumentsList, cwd });
}

describe("inspectLocalGitState", () => {
  it.each([
    ["main", true],
    ["feature/nested-workspace", true],
    ["feature/-bar", true],
    ["feature/bar-", true],
    ["-", false],
    ["-feature", false],
    ["@", false],
    ["feature@{broken}", false],
    ["feature..broken", false],
    ["feature/.hidden", false],
    ["feature/branch.lock", false],
  ] as const)("validates Git branch identity %s", (branch, expected) => {
    expect(isValidGitBranchName(branch)).toBe(expected);
  });

  it.each([
    ["refs/heads/main", true],
    ["refs/heads/feature/nested", true],
    ["refs/heads/-feature", false],
    ["refs/heads/@", false],
    ["refs/tags/main", false],
    ["refs/heads/feature@{broken}", false],
  ] as const)("validates Git target ref identity %s", (ref, expected) => {
    expect(isValidGitTargetRef(ref)).toBe(expected);
  });

  it("excludes durable state under a nested workspace without hiding unrelated dirty files", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-nested-workspace-"));
    const workspace = join(root, "packages", "service");
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "test: nested workspace"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await mkdir(join(workspace, ".d-ai", "tasks"), { recursive: true });
      await writeFile(join(workspace, ".d-ai", "tasks", "state.json"), "durable state\n", "utf8");
      await writeFile(join(workspace, "notes.txt"), "unrelated dirty file\n", "utf8");

      const state = await inspectLocalGitState(workspace, "origin", "refs/heads/main");

      expect(state.worktreeStatus).toContain("notes.txt");
      expect(state.worktreeStatus).not.toContain(".d-ai");

      await git(root, ["add", "--", "packages/service/.d-ai"]);
      await git(root, ["commit", "-m", "test: track durable state"]);
      await writeFile(join(workspace, ".d-ai", "tasks", "state.json"), "updated durable state\n", "utf8");
      const trackedState = await inspectLocalGitState(workspace, "origin", "refs/heads/main");

      expect(trackedState.worktreeStatus).toContain("notes.txt");
      expect(trackedState.worktreeStatus).not.toContain(".d-ai");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the production current-state path scoped to a nested workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-current-nested-"));
    const workspace = join(root, "packages", "service");
    try {
      await mkdir(workspace, { recursive: true });
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "test: current nested workspace"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await mkdir(join(workspace, ".d-ai", "tasks"), { recursive: true });
      await writeFile(join(workspace, ".d-ai", "tasks", "state.json"), "durable state\n", "utf8");
      await writeFile(join(workspace, "notes.txt"), "unrelated dirty file\n", "utf8");

      const state = await inspectCurrentGitState(workspace, "origin");

      expect(state.worktreeStatus).toContain("notes.txt");
      expect(state.worktreeStatus).not.toContain(".d-ai");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
