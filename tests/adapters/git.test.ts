import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandExecutionError, runCommand } from "../../src/adapters/command-runner.js";
import { inspectConfiguredGitRemotes, inspectConfiguredGitRepositoryIdentity, inspectCurrentGitState, inspectGitRepositoryHealth, inspectLocalGitState, isValidGitBranchName, isValidGitTargetRef, literalExcludePathspec } from "../../src/adapters/git.js";

async function git(cwd: string | null, argumentsList: readonly string[]): Promise<void> {
  await runCommand({ command: "git", arguments: argumentsList, cwd });
}

async function gitObserved(cwd: string, argumentsList: readonly string[]) {
  try {
    return await runCommand({ command: "git", arguments: argumentsList, cwd });
  } catch (error: unknown) {
    if (error instanceof CommandExecutionError) return error.result;
    throw error;
  }
}

async function gitWithInput(cwd: string, argumentsList: readonly string[], input: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", [...argumentsList], { cwd, shell: false, windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectPromise);
    child.once("close", (exitCode) => {
      if (exitCode === 0) resolvePromise();
      else rejectPromise(new Error(`git ${argumentsList.join(" ")} failed (${exitCode}): ${stderr}`));
    });
    child.stdin.end(input);
  });
}

describe("inspectLocalGitState", () => {
  it.each([
    "packages/star*name/.d-ai",
    "packages/question?name/.d-ai",
    "packages/bracket[one]/.d-ai",
    "packages/colon:magic/.d-ai",
  ])("constructs a literal exclude pathspec for %s", (path) => {
    expect(literalExcludePathspec(path)).toBe(`:(exclude,literal)${path}`);
  });

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

  it.each([
    ["asterisk", "packages/star*name", "packages/starZZname"],
    ["question mark", "packages/question?name", "packages/questionXname"],
    ["bracket", "packages/bracket[one]", "packages/bracketo"],
  ] as const)("keeps sibling durable-like dirt visible for a literal %s workspace path", async (_label, workspaceRelativePath, siblingRelativePath) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-literal-pathspec-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "test: literal pathspec"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await mkdir(join(root, siblingRelativePath, ".d-ai"), { recursive: true });
      await writeFile(join(root, siblingRelativePath, ".d-ai", "sibling.txt"), "sibling dirty state\n", "utf8");

      const state = await inspectLocalGitState(root, "origin", "refs/heads/main", join(root, workspaceRelativePath));

      expect(state.worktreeStatus).toContain("sibling.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("excludes only the real bracketed workspace durable state while preserving staged, modified, and untracked dirt", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-bracketed-workspace-"));
    const workspace = join(root, "packages", "literal[workspace]");
    const siblingDurable = join(root, "packages", "literalw", ".d-ai");
    try {
      await mkdir(join(root, "packages"), { recursive: true });
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await writeFile(join(root, "staged.txt"), "staged\n", "utf8");
      await writeFile(join(root, "modified.txt"), "modified\n", "utf8");
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "test: bracketed workspace"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await mkdir(join(workspace, ".d-ai", "tasks"), { recursive: true });
      await writeFile(join(workspace, ".d-ai", "tasks", "state.json"), "intended durable state\n", "utf8");
      await mkdir(siblingDurable, { recursive: true });
      await writeFile(join(siblingDurable, "sibling.txt"), "sibling dirty state\n", "utf8");
      await writeFile(join(root, "tracked.txt"), "tracked changed\n", "utf8");
      await writeFile(join(root, "staged.txt"), "staged changed\n", "utf8");
      await git(root, ["add", "staged.txt"]);
      await writeFile(join(root, "notes.txt"), "untracked dirty file\n", "utf8");

      const state = await inspectLocalGitState(root, "origin", "refs/heads/main", workspace);

      expect(state.worktreeStatus).toContain("tracked.txt");
      expect(state.worktreeStatus).toContain("staged.txt");
      expect(state.worktreeStatus).toContain("notes.txt");
      expect(state.worktreeStatus).toContain("sibling.txt");
      expect(state.worktreeStatus).not.toContain("state.json");
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

  it("resolves configured repository identity from a detached commit without relaxing branch-sensitive inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-detached-identity-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: detached repository identity"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      const attached = await inspectConfiguredGitRepositoryIdentity(root);
      await expect(inspectLocalGitState(root, "origin", "refs/heads/other")).rejects.toThrow(/does not match configured target ref/i);
      await git(root, ["checkout", "--detach", "HEAD"]);

      const detached = await inspectConfiguredGitRepositoryIdentity(root);

      expect(detached).toEqual(attached);
      await expect(inspectCurrentGitState(root, "origin")).rejects.toThrow(/symbolic-ref|branch/i);
      await expect(inspectLocalGitState(root, "origin", "refs/heads/main")).rejects.toThrow(/symbolic-ref|branch/i);
      await expect(inspectLocalGitState(root, "origin", "refs/heads/other")).rejects.toThrow(/symbolic-ref|branch/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves a dirty linked detached worktree while resolving the shared repository identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-linked-detached-identity-"));
    const linked = join(root, "linked");
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "committed\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: linked detached identity"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      const originalIdentity = await inspectConfiguredGitRepositoryIdentity(root);
      await git(root, ["worktree", "add", "--detach", linked, "HEAD"]);
      await writeFile(join(linked, "staged.txt"), "staged bytes\n", "utf8");
      await git(linked, ["add", "staged.txt"]);
      await writeFile(join(linked, "tracked.txt"), "unstaged tracked bytes\n", "utf8");
      await writeFile(join(linked, "untracked.txt"), "untracked bytes\n", "utf8");
      const observe = async () => {
        const [head, symbolicRef, indexLocation, indexEntries, stagedDiff, unstagedDiff, logicalStatus, trackedBytes, stagedBytes, untrackedBytes] = await Promise.all([
          gitObserved(linked, ["rev-parse", "HEAD"]),
          gitObserved(linked, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
          gitObserved(linked, ["rev-parse", "--git-path", "index"]),
          gitObserved(linked, ["ls-files", "--stage"]),
          gitObserved(linked, ["diff", "--cached", "--binary"]),
          gitObserved(linked, ["diff", "--binary"]),
          gitObserved(linked, ["status", "--porcelain=v1", "--untracked-files=all"]),
          readFile(join(linked, "tracked.txt")),
          readFile(join(linked, "staged.txt")),
          readFile(join(linked, "untracked.txt")),
        ]);
        const indexPath = resolve(linked, indexLocation.stdout.trim());
        return {
          head: head.stdout.trim(),
          symbolicRef: { exitCode: symbolicRef.exitCode, stdout: symbolicRef.stdout, stderr: symbolicRef.stderr },
          indexEntries: indexEntries.stdout,
          indexBytes: (await readFile(indexPath)).toString("base64"),
          stagedDiff: stagedDiff.stdout,
          unstagedDiff: unstagedDiff.stdout,
          logicalStatus: logicalStatus.stdout,
          files: [trackedBytes, stagedBytes, untrackedBytes].map((bytes) => bytes.toString("base64")),
        };
      };
      const before = await observe();

      const linkedIdentity = await inspectConfiguredGitRepositoryIdentity(linked);

      const after = await observe();
      expect(linkedIdentity).toMatchObject({
        head: originalIdentity.head,
        remote: originalIdentity.remote,
        remoteUrl: originalIdentity.remoteUrl,
        pushUrl: originalIdentity.pushUrl,
      });
      const [repositoryPath, linkedPath] = await Promise.all([realpath(linkedIdentity.repositoryPath), realpath(linked)]);
      expect(process.platform === "win32" ? repositoryPath.toLowerCase() : repositoryPath)
        .toBe(process.platform === "win32" ? linkedPath.toLowerCase() : linkedPath);
      expect(before.symbolicRef.exitCode).toBe(1);
      expect(before.stagedDiff).toContain("staged bytes");
      expect(before.unstagedDiff).toContain("unstaged tracked bytes");
      expect(before.logicalStatus).toContain("untracked.txt");
      expect(after).toEqual(before);
    } finally {
      await git(root, ["worktree", "remove", "--force", linked]).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when the configured identity repository has an unreadable index", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-detached-identity-corrupt-index-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: corrupt identity index"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      const indexPathResult = await runCommand({ command: "git", arguments: ["rev-parse", "--git-path", "index"], cwd: root });
      const indexPath = resolve(root, indexPathResult.stdout.trim());
      await writeFile(indexPath, "corrupted index\n", "utf8");

      await expect(inspectConfiguredGitRepositoryIdentity(root)).rejects.toThrow(/index|cache|corrupt|git/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inspects a large valid index without emitting or buffering its entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-identity-large-index-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: large identity index"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      const blob = (await runCommand({ command: "git", arguments: ["rev-parse", "HEAD:tracked.txt"], cwd: root })).stdout.trim();
      const virtualPaths = Array.from({ length: 25_000 }, (_, index) => `virtual/entry-${String(index).padStart(5, "0")}.txt`);
      const entries = virtualPaths.map((path) => `100644 ${blob}\t${path}\n`).join("");
      await gitWithInput(root, ["update-index", "--index-info"], entries);
      await gitWithInput(root, ["update-index", "--skip-worktree", "-z", "--stdin"], `${virtualPaths.join("\0")}\0`);
      await expect(inspectCurrentGitState(root, "origin")).resolves.toMatchObject({ remoteUrl: "https://github.com/example/d-ai.git" });

      await expect(inspectConfiguredGitRepositoryIdentity(root)).resolves.toMatchObject({ remoteUrl: "https://github.com/example/d-ai.git" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["unborn", "missing-object", "non-commit"] as const)("rejects %s HEAD during configured identity inspection", async (headKind) => {
    const root = await mkdtemp(join(tmpdir(), `d-ai-git-identity-${headKind}-`));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      if (headKind !== "unborn") {
        await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
        await git(root, ["add", "tracked.txt"]);
        await git(root, ["commit", "-m", "test: invalid identity HEAD"]);
        if (headKind === "missing-object") {
          await writeFile(join(root, ".git", "HEAD"), `${"1".repeat(40)}\n`, "utf8");
        } else {
          await git(root, ["hash-object", "-w", "tracked.txt"]);
          const blob = (await runCommand({ command: "git", arguments: ["hash-object", "tracked.txt"], cwd: root })).stdout.trim();
          await writeFile(join(root, ".git", "HEAD"), `${blob}\n`, "utf8");
        }
      }
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);

      await expect(inspectConfiguredGitRepositoryIdentity(root)).rejects.toThrow(/HEAD|commit|object|reference/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, multiple, or unusable configured origin endpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-identity-origin-endpoints-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: identity remote endpoints"]);
      await expect(inspectConfiguredGitRepositoryIdentity(root)).rejects.toThrow(/remote URL|endpoint/i);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await git(root, ["config", "--add", "remote.origin.url", "https://github.com/example/other.git"]);
      await expect(inspectConfiguredGitRepositoryIdentity(root)).rejects.toThrow(/exactly one endpoint/i);
      await git(root, ["config", "--unset-all", "remote.origin.url"]);
      await git(root, ["config", "remote.origin.url", "file:///tmp/d-ai-not-github"]);
      await expect(inspectConfiguredGitRepositoryIdentity(root)).resolves.toMatchObject({ remoteUrl: "file:///tmp/d-ai-not-github" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a non-repository root and an illegal configured remote name", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-identity-invalid-root-"));
    const notRepository = join(root, "not-repository");
    try {
      await mkdir(notRepository, { recursive: true });
      await expect(inspectConfiguredGitRepositoryIdentity(notRepository)).rejects.toThrow(/repository|Git|rev-parse/i);
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: illegal identity remote name"]);

      await expect(inspectConfiguredGitRepositoryIdentity(root, "bad/name")).rejects.toThrow(/remote name is invalid/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects multiple push endpoints and ambiguous or cyclic URL rewrite rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-identity-push-rewrite-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: identity push rewrite"]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await git(root, ["config", "--add", "remote.origin.pushurl", "https://github.com/example/one.git"]);
      await git(root, ["config", "--add", "remote.origin.pushurl", "https://github.com/example/two.git"]);
      await expect(inspectConfiguredGitRepositoryIdentity(root)).rejects.toThrow(/at most one endpoint/i);
      await git(root, ["config", "--unset-all", "remote.origin.pushurl"]);
      await git(root, ["config", "--add", "url.beta://.insteadOf", "alpha://"]);
      await git(root, ["config", "--add", "url.alpha://.insteadOf", "beta://"]);
      await git(root, ["config", "remote.origin.url", "alpha://repository"]);

      await expect(inspectConfiguredGitRepositoryIdentity(root)).rejects.toThrow(/cycle/i);
      await git(root, ["config", "--unset-all", "url.beta://.insteadOf"]);
      await git(root, ["config", "--unset-all", "url.alpha://.insteadOf"]);
      await git(root, ["config", "--add", "url.beta://.insteadOf", "alpha://"]);
      await git(root, ["config", "--add", "url.gamma://.insteadOf", "alpha://"]);

      await expect(inspectConfiguredGitRepositoryIdentity(root)).rejects.toThrow(/ambiguous longest-prefix/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports exactly the configured Git remote names, including zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-configured-remotes-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await expect(inspectConfiguredGitRemotes(root)).resolves.toEqual([]);
      await git(root, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await git(root, ["remote", "add", "backup", "https://github.com/example/d-ai-backup.git"]);
      await expect(inspectConfiguredGitRemotes(root)).resolves.toEqual(["backup", "origin"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a corrupt Git index during repository health inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-health-corrupt-index-"));
    try {
      await git(root, ["init", "-b", "main"]);
      await git(root, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(root, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(root, "tracked.txt"), "tracked\n", "utf8");
      await git(root, ["add", "tracked.txt"]);
      await git(root, ["commit", "-m", "test: corrupt index health"]);
      await writeFile(join(root, ".git", "index"), "corrupted index\n", "utf8");
      await expect(inspectGitRepositoryHealth(root)).rejects.toThrow(/status|index|Git/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a workspace alias that resolves outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-git-outside-workspace-"));
    const repository = join(root, "repository");
    const outside = join(root, "outside");
    const workspaceAlias = join(repository, "workspace-link");
    try {
      await mkdir(repository);
      await mkdir(outside);
      await git(repository, ["init", "-b", "main"]);
      await git(repository, ["config", "user.email", "d-ai-test@example.invalid"]);
      await git(repository, ["config", "user.name", "D-AI Test"]);
      await writeFile(join(repository, "tracked.txt"), "tracked\n", "utf8");
      await git(repository, ["add", "."]);
      await git(repository, ["commit", "-m", "test: outside workspace alias"]);
      await git(repository, ["remote", "add", "origin", "https://github.com/example/d-ai.git"]);
      await symlink(outside, workspaceAlias, process.platform === "win32" ? "junction" : "dir");

      await expect(inspectLocalGitState(repository, "origin", "refs/heads/main", workspaceAlias))
        .rejects.toThrow(/inside the Git repository root/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
