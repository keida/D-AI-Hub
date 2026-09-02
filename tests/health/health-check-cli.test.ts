import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { runHealthCheckCLI } from "../../src/health/health-check-cli.js";

const requiredFiles = [
  "AGENTS.md",
  "README.md",
  "indexes/SKILLS.md",
  "indexes/KNOWLEDGE.md",
  "indexes/PROJECTS.md",
  "projects/d-ai-hub/STATUS.md",
] as const;

const temporaryRoots: string[] = [];

async function git(workspacePath: string, argumentsList: readonly string[]): Promise<void> {
  await runCommand({ command: "git", arguments: argumentsList, cwd: workspacePath });
}

async function createRepositoryFixture(): Promise<string> {
  const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-health-cli-"));
  temporaryRoots.push(workspacePath);
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "health-check@example.test"]);
  await git(workspacePath, ["config", "user.name", "Repository Health Check"]);
  for (const relativePath of requiredFiles) {
    const filePath = join(workspacePath, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, relativePath === "projects/d-ai-hub/STATUS.md" ? [
      "# Status",
      "## State",
      "- Lifecycle: active",
      "- Active PR: none",
      "## Current checkpoint",
      "- Current PR: none",
    ].join("\n") : `${relativePath}\n`, "utf8");
  }
  await writeFile(join(workspacePath, "indexes", "PROJECTS.md"), [
    "# Project Index",
    "## Active projects",
    "- [D-AI-Hub](../projects/d-ai-hub/)",
    "## Continuation rule",
    "Use progressive loading from the canonical [Project Memory Skill](../skills/custom/project-memory/SKILL.md): read STATUS.md first. Read the complete project set only for close or audit.",
  ].join("\n"), "utf8");
  await mkdir(join(workspacePath, "skills", "custom", "project-memory"), { recursive: true });
  await writeFile(join(workspacePath, "skills", "custom", "project-memory", "SKILL.md"), [
    "---",
    "name: example",
    "description: Example fixture Skill",
    "---",
    "# Example",
  ].join("\n"), "utf8");
  await writeFile(join(workspacePath, "indexes", "SKILLS.md"), "[project memory](../skills/custom/project-memory/SKILL.md)\n", "utf8");
  await writeFile(join(workspacePath, "package.json"), `${JSON.stringify({
    name: "repository-health-cli-fixture",
    private: true,
    scripts: {
      build: "node -e \"process.stdout.write('build ok')\"",
      test: "node -e \"process.stdout.write('test ok')\"",
    },
  })}\n`, "utf8");
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", "create health check fixture"]);
  return workspacePath;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("runHealthCheckCLI", () => {
  it("returns a healthy report with exit code zero", async () => {
    const workspacePath = await createRepositoryFixture();

    const result = await runHealthCheckCLI(["--workspace", workspacePath]);

    expect(result.exitCode).toBe(0);
    expect(result.report.status).toBe("healthy");
  }, 20_000);

  it("requires exactly one non-empty workspace argument", async () => {
    await expect(runHealthCheckCLI([])).rejects.toThrow(/--workspace/i);
    await expect(runHealthCheckCLI(["--workspace"])).rejects.toThrow(/--workspace/i);
    await expect(runHealthCheckCLI(["--workspace", "   "])).rejects.toThrow(/non-empty/i);
    await expect(runHealthCheckCLI(["--workspace", "one", "--workspace", "two"])).rejects.toThrow(/exactly one/i);
    await expect(runHealthCheckCLI(["--other", "value"])).rejects.toThrow(/--workspace/i);
  });

  it("maps an unhealthy report to exit code one", async () => {
    const workspacePath = await createRepositoryFixture();
    await writeFile(join(workspacePath, "README.md"), "changed\n", "utf8");

    const result = await runHealthCheckCLI(["--workspace", workspacePath]);

    expect(result.exitCode).toBe(1);
    expect(result.report.status).toBe("unhealthy");
  }, 20_000);

  it("maps a blocked report to exit code two", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-health-cli-non-git-"));
    temporaryRoots.push(workspacePath);

    const result = await runHealthCheckCLI(["--workspace", workspacePath]);

    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe("blocked");
  });

  it("redacts thrown errors in a blocked report", async () => {
    const result = await runHealthCheckCLI(["--workspace", "C:\\missing\0token=super-secret"]);

    expect(result.exitCode).toBe(2);
    expect(result.report.status).toBe("blocked");
    expect(JSON.stringify(result.report)).toContain("[REDACTED]");
    expect(JSON.stringify(result.report)).not.toContain("super-secret");
  });

  it("prints only the JSON report when the CLI module is directly invoked", async () => {
    const workspacePath = await createRepositoryFixture();
    const cliCommand = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "node_modules/.bin/tsx";
    const cliArguments = process.platform === "win32"
      ? ["/d", "/s", "/c", ".\\node_modules\\.bin\\tsx.cmd", "src/health/health-check-cli.ts", "--workspace", workspacePath]
      : ["src/health/health-check-cli.ts", "--workspace", workspacePath];

    const result = await runCommand({
      command: cliCommand,
      arguments: cliArguments,
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "healthy" });
  }, 30_000);
});
