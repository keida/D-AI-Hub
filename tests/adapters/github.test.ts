import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubCliAdapter, GitRemoteBlockedError, resolveGitHubRepository } from "../../src/adapters/github.js";
import { classifyGitFailure } from "../../src/adapters/git.js";
import { runCommand } from "../../src/adapters/command-runner.js";

describe("resolveGitHubRepository", () => {
  it("normalizes SSH and HTTPS GitHub remotes without retaining credentials", () => {
    expect(resolveGitHubRepository("git@github.com:acme/d-ai.git", null)).toEqual({
      host: "github.com",
      repository: "github.com/acme/d-ai",
    });
    expect(resolveGitHubRepository("https://github.com/acme/d-ai.git", null)).toEqual({
      host: "github.com",
      repository: "github.com/acme/d-ai",
    });
  });

  it("allows an Enterprise remote only when its host is configured explicitly", () => {
    expect(resolveGitHubRepository("ssh://git@git.example.test/acme/d-ai.git", "git.example.test")).toEqual({
      host: "git.example.test",
      repository: "git.example.test/acme/d-ai",
    });
  });

  it("blocks an unconfigured non-GitHub remote before any push", () => {
    expect(() => resolveGitHubRepository("https://gitlab.example.test/acme/d-ai.git", null)).toThrow(GitRemoteBlockedError);
  });

  it("blocks credential-bearing HTTPS remotes instead of exposing them to command output", () => {
    expect(() => resolveGitHubRepository("https://secret-token@github.com/acme/d-ai.git", null)).toThrow(GitRemoteBlockedError);
  });

  it("blocks unsupported HTTPS and SSH ports", () => {
    expect(() => resolveGitHubRepository("https://github.com:8443/acme/d-ai.git", null)).toThrow(GitRemoteBlockedError);
    expect(() => resolveGitHubRepository("ssh://git@github.com:2222/acme/d-ai.git", null)).toThrow(GitRemoteBlockedError);
  });
});

describe("classifyGitFailure", () => {
  it.each([
    ["Authentication failed", "authentication"],
    ["Permission denied (publickey)", "permission"],
    ["Could not resolve host: github.com", "network"],
    ["repository not found", "remote-unavailable"],
    ["[rejected] main -> main (non-fast-forward)", "verification-mismatch"],
    ["unrecognized failure", "ambiguous"],
  ] as const)("classifies %s as %s", (observedOutput, expected) => {
    expect(classifyGitFailure(observedOutput)).toBe(expected);
  });
});

describe("GitHubCliAdapter external boundary", () => {
  it("blocks before transport when external credentials are not configured", async () => {
    const external = GitHubCliAdapter.create({ mode: "external", enterpriseHost: null, credentialsConfigured: false });

    await expect(external.pushExpectedCommit("not-a-repository", "origin", "refs/heads/main", "0".repeat(40), "github.com/acme/d-ai")).rejects.toThrow(/credentials|configuration/i);
  });

  it("does not push a local HEAD that differs from the durable commit artifact", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "d-ai-github-expected-commit-"));
    const git = async (argumentsList: readonly string[]): Promise<string> => (await runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath })).stdout.trim();
    let pushCalls = 0;
    const adapter = GitHubCliAdapter.forTestTransport(
      { mode: "test", enterpriseHost: null },
      {
        pushRef: async () => {
          pushCalls += 1;
          return { pushed: true, observedOutput: "pushed", exitCode: 0, failureCategory: null };
        },
        readRef: async () => ({ command: "git", arguments: ["ls-remote"], stdout: "", stderr: "", exitCode: 0 }),
      },
    );

    try {
      await git(["init", "--initial-branch=main"]);
      await git(["config", "user.email", "d-ai@example.test"]);
      await git(["config", "user.name", "D-AI Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "known good\n", "utf8");
      await git(["add", "artifact.txt"]);
      await git(["commit", "-m", "known good"]);
      await git(["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);
      const localHead = await git(["rev-parse", "HEAD"]);

      const evidence = await adapter.pushExpectedCommit(repositoryPath, "origin", "refs/heads/main", "0".repeat(40), "github.com/acme/d-ai");

      expect(pushCalls).toBe(0);
      expect(evidence).toMatchObject({ localSha: localHead, pushed: false, exitCode: 1, failureCategory: "verification-mismatch" });
      expect(evidence.observedOutput).toMatch(/durable|expected|commit/i);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("blocks a remote repository change before transport when close supplies the durable identity", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "d-ai-github-repository-identity-"));
    const git = async (argumentsList: readonly string[]): Promise<string> => (await runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath })).stdout.trim();
    let pushCalls = 0;
    const adapter = GitHubCliAdapter.forTestTransport(
      { mode: "test", enterpriseHost: null },
      {
        pushRef: async () => {
          pushCalls += 1;
          return { pushed: true, observedOutput: "pushed", exitCode: 0, failureCategory: null };
        },
        readRef: async () => ({ command: "git", arguments: ["ls-remote"], stdout: "", stderr: "", exitCode: 0 }),
      },
    );

    try {
      await git(["init", "--initial-branch=main"]);
      await git(["config", "user.email", "d-ai@example.test"]);
      await git(["config", "user.name", "D-AI Test"]);
      await writeFile(join(repositoryPath, "artifact.txt"), "known good\n", "utf8");
      await git(["add", "artifact.txt"]);
      await git(["commit", "-m", "known good"]);
      await git(["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);

      await expect(adapter.pushExpectedCommit(repositoryPath, "origin", "refs/heads/main", "0".repeat(40), "github.com/other/repository")).rejects.toThrow(/repository identity/i);
      expect(pushCalls).toBe(0);
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });

  it("blocks when a direct caller omits the durable repository identity", async () => {
    const adapter = GitHubCliAdapter.forTestTransport(
      { mode: "test", enterpriseHost: null },
      { pushRef: async () => ({ pushed: true, observedOutput: "pushed", exitCode: 0, failureCategory: null }), readRef: async () => ({ command: "git", arguments: [], stdout: "", stderr: "", exitCode: 0 }) },
    );
    await expect(adapter.pushExpectedCommit("not-a-repository", "origin", "refs/heads/main", "0".repeat(40), undefined as unknown as string)).rejects.toThrow(/repository identity/i);
  });

  it("requires the durable repository identity before remote verification transport", async () => {
    let readCalls = 0;
    const adapter = GitHubCliAdapter.forTestTransport(
      { mode: "test", enterpriseHost: null },
      {
        pushRef: async () => ({ pushed: true, observedOutput: "pushed", exitCode: 0, failureCategory: null }),
        readRef: async () => {
          readCalls += 1;
          return { command: "git", arguments: [], stdout: `${"a".repeat(40)}\trefs/heads/main\n`, stderr: "", exitCode: 0 };
        },
      },
    );

    await expect(adapter.verifyRemoteState("not-a-repository", "origin", "github.com/acme/d-ai", "refs/heads/main", "a".repeat(40), "github.com/other/d-ai" as string)).rejects.toThrow(/repository identity/i);
    await expect(adapter.verifyRemoteState("not-a-repository", "origin", "github.com/acme/d-ai", "refs/heads/main", "a".repeat(40), undefined as unknown as string)).rejects.toThrow(/repository identity/i);
    expect(readCalls).toBe(0);
  });
});
