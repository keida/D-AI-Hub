import { describe, expect, it } from "vitest";
import { GitHubCliAdapter, GitRemoteBlockedError, resolveGitHubRepository } from "../../src/adapters/github.js";
import { classifyGitFailure } from "../../src/adapters/git.js";

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

    await expect(external.pushExpectedCommit("not-a-repository", "origin", "refs/heads/main")).rejects.toThrow(/credentials|configuration/i);
  });
});
