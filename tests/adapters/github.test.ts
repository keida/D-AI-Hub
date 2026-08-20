import { describe, expect, it } from "vitest";
import { GitRemoteBlockedError, resolveGitHubRepository } from "../../src/adapters/github.js";

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
});
