import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";
import { runRepositoryHealthCheck } from "../../src/health/repository-health-check.js";

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

async function commitFixtureChanges(workspacePath: string, message: string): Promise<void> {
  await git(workspacePath, ["add", "."]);
  await git(workspacePath, ["commit", "-m", message]);
}

type FixtureOptions = {
  readonly markdown?: string;
  readonly buildCommand?: string;
  readonly testCommand?: string;
  readonly sourceSymlinkOutside?: boolean;
  readonly nestedWorkspace?: boolean;
};

async function createRepositoryFixture(options: FixtureOptions = {}): Promise<string> {
  const fixtureOptions = {
    markdown: "",
    buildCommand: "node -e \"process.stdout.write('build ok')\"",
    testCommand: "node -e \"process.stdout.write('test ok')\"",
    ...options,
  };
  const fixtureContainer = await mkdtemp(join(tmpdir(), "d-ai-repository-health-"));
  const workspacePath = fixtureOptions.nestedWorkspace ? join(fixtureContainer, "workspace") : fixtureContainer;
  temporaryRoots.push(fixtureOptions.nestedWorkspace ? fixtureContainer : workspacePath);
  if (fixtureOptions.nestedWorkspace) await mkdir(workspacePath, { recursive: true });
  await git(workspacePath, ["init", "-b", "main"]);
  await git(workspacePath, ["config", "user.email", "health-check@example.test"]);
  await git(workspacePath, ["config", "user.name", "Repository Health Check"]);
  for (const relativePath of requiredFiles) {
    const filePath = join(workspacePath, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${relativePath}\n`, "utf8");
  }
  const catalogFiles = [
    "skills/custom/example/SKILL.md",
    ".agents/skills/example/SKILL.md",
    "skills/external/example.md",
    "knowledge/ai/example.md",
  ] as const;
  for (const relativePath of catalogFiles) {
    const filePath = join(workspacePath, relativePath);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, `${relativePath}\n`, "utf8");
  }
  await writeFile(join(workspacePath, "indexes", "SKILLS.md"), [
    "[custom](../skills/custom/example/SKILL.md)",
    "[compatibility](../.agents/skills/example/SKILL.md)",
    "[external](../skills/external/example.md)",
  ].join("\n"), "utf8");
  await writeFile(join(workspacePath, "indexes", "KNOWLEDGE.md"), "[AI](../knowledge/ai/)\n", "utf8");
  await writeFile(join(workspacePath, "indexes", "PROJECTS.md"), "[D-AI-Hub](../projects/d-ai-hub/)\n", "utf8");
  await writeFile(join(workspacePath, "package.json"), `${JSON.stringify({
    name: "repository-health-fixture",
    private: true,
    scripts: {
      build: fixtureOptions.buildCommand,
      test: fixtureOptions.testCommand,
    },
  })}\n`, "utf8");
  if (fixtureOptions.markdown.length > 0) {
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    await writeFile(join(workspacePath, "docs", "links.md"), fixtureOptions.markdown, "utf8");
    await writeFile(join(workspacePath, "docs", "target.md"), "target\n", "utf8");
  }
  if (fixtureOptions.sourceSymlinkOutside) {
    await mkdir(join(workspacePath, "docs"), { recursive: true });
    const outsideRoot = await mkdtemp(join(tmpdir(), "d-ai-repository-health-outside-"));
    temporaryRoots.splice(Math.max(0, temporaryRoots.length - 1), 0, outsideRoot);
    await writeFile(join(outsideRoot, "external.md"), "[external-content-must-not-be-read](missing-external-target.md)\n", "utf8");
    await symlink(outsideRoot, join(workspacePath, "docs", "external"), "junction");
  }
  await git(workspacePath, fixtureOptions.sourceSymlinkOutside
    ? ["add", ...requiredFiles, "package.json", "docs/external/external.md"]
    : ["add", "."]);
  await git(workspacePath, ["commit", "-m", "create health-check fixture"]);
  return workspacePath;
}

function checkWithId(report: Awaited<ReturnType<typeof runRepositoryHealthCheck>>, id: string) {
  const check = report.checks.find((candidate) => candidate.id === id);
  expect(check).toBeDefined();
  return check!;
}

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
});

describe("runRepositoryHealthCheck", () => {
  it("reports a clean repository as healthy", async () => {
    const workspacePath = await createRepositoryFixture();

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("healthy");
    expect(report.workspacePath).toBe(resolve(workspacePath));
    expect(checkWithId(report, "repository-identity").status).toBe("passed");
    expect(checkWithId(report, "working-tree").status).toBe("passed");
    expect(checkWithId(report, "required-files").status).toBe("passed");
    expect(checkWithId(report, "index-freshness")).toEqual({
      id: "index-freshness",
      status: "passed",
      observation: "All required catalog targets are indexed exactly once",
    });
    expect(checkWithId(report, "markdown-links").status).toBe("passed");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("passed");
  });

  it("validates tracked Markdown links while skipping external, mail, and anchor links", async () => {
    const workspacePath = await createRepositoryFixture({
      markdown: [
        "[target](target.md)",
        "[target anchor](target.md#section)",
        "[target title](target.md \"a title\")",
        "[external](https://example.com)",
        "[mail](mailto:team@example.com)",
        "[protocol-relative](//example.com)",
        "[section](#section)",
      ].join("\n"),
    });

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("healthy");
    expect(checkWithId(report, "markdown-links")).toEqual({
      id: "markdown-links",
      status: "passed",
      observation: "All tracked Markdown links resolve within the repository",
    });
    expect(report.checks.map((check) => check.id)).toEqual([
      "repository-identity",
      "working-tree",
      "required-files",
      "index-freshness",
      "markdown-links",
      "build",
      "test",
      "working-tree-final",
    ]);
  });

  it.each([
    ["indexes/SKILLS.md", "skills/custom/example/SKILL.md"],
    ["indexes/KNOWLEDGE.md", "knowledge/ai"],
    ["indexes/PROJECTS.md", "projects/d-ai-hub"],
  ])("reports a missing catalog target from %s while later checks still run", async (indexPath, expectedTarget) => {
    const workspacePath = await createRepositoryFixture();
    await writeFile(join(workspacePath, indexPath), "# Empty catalog\n", "utf8");
    await commitFixtureChanges(workspacePath, `remove catalog entry from ${indexPath}`);

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("unhealthy");
    const freshnessCheck = checkWithId(report, "index-freshness");
    expect(freshnessCheck.status).toBe("failed");
    expect(freshnessCheck.observation).toContain(indexPath);
    expect(freshnessCheck.observation).toContain(expectedTarget);
    expect(checkWithId(report, "markdown-links").status).toBe("passed");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("passed");
  });

  it("reports a duplicate required catalog target deterministically", async () => {
    const workspacePath = await createRepositoryFixture();
    await writeFile(join(workspacePath, "indexes", "SKILLS.md"), [
      "[custom one](../skills/custom/example/SKILL.md)",
      "[custom two](../skills/custom/example/SKILL.md#usage)",
      "[compatibility](../.agents/skills/example/SKILL.md)",
      "[external](../skills/external/example.md)",
    ].join("\n"), "utf8");
    await commitFixtureChanges(workspacePath, "duplicate custom skill entry");

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(checkWithId(report, "index-freshness")).toEqual({
      id: "index-freshness",
      status: "failed",
      observation: "Index freshness findings: indexes/SKILLS.md: skills/custom/example/SKILL.md (2 links)",
    });
  });

  it("allows an additional promoted knowledge-note link", async () => {
    const workspacePath = await createRepositoryFixture();
    await writeFile(join(workspacePath, "indexes", "KNOWLEDGE.md"), [
      "[AI](../knowledge/ai/)",
      "[Promoted note](../knowledge/ai/example.md)",
    ].join("\n"), "utf8");
    await commitFixtureChanges(workspacePath, "promote knowledge note");

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(checkWithId(report, "index-freshness").status).toBe("passed");
  });

  it("excludes the external provenance README and project template", async () => {
    const workspacePath = await createRepositoryFixture();
    await mkdir(join(workspacePath, "projects", "_template"), { recursive: true });
    await writeFile(join(workspacePath, "projects", "_template", "STATUS.md"), "template\n", "utf8");
    await writeFile(join(workspacePath, "skills", "external", "README.md"), "provenance guide\n", "utf8");
    await commitFixtureChanges(workspacePath, "add excluded catalog files");

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(checkWithId(report, "index-freshness").status).toBe("passed");
  });

  it("requires a tracked planned project to be indexed", async () => {
    const workspacePath = await createRepositoryFixture();
    await mkdir(join(workspacePath, "projects", "planned-project"), { recursive: true });
    await writeFile(join(workspacePath, "projects", "planned-project", "STATUS.md"), "planned\n", "utf8");
    await commitFixtureChanges(workspacePath, "add planned project");

    const report = await runRepositoryHealthCheck({ workspacePath });

    const freshnessCheck = checkWithId(report, "index-freshness");
    expect(freshnessCheck.status).toBe("failed");
    expect(freshnessCheck.observation).toContain("projects/planned-project");
  });

  it("ignores untracked catalog candidates", async () => {
    const workspacePath = await createRepositoryFixture();
    await mkdir(join(workspacePath, "projects", "untracked-project"), { recursive: true });
    await writeFile(join(workspacePath, "projects", "untracked-project", "STATUS.md"), "untracked\n", "utf8");

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(checkWithId(report, "working-tree").status).toBe("failed");
    expect(checkWithId(report, "index-freshness").status).toBe("passed");
  });

  it.each(["x".repeat(160), "中".repeat(50)])("blocks index freshness with a bounded diagnostic when tracked-path enumeration exceeds its limit (%#)", async (outputPadding) => {
    const workspacePath = await createRepositoryFixture();
    const bulkDirectory = join(workspacePath, "bulk");
    await mkdir(bulkDirectory, { recursive: true });
    for (let index = 0; index < 450; index += 1) {
      const suffix = index.toString().padStart(4, "0");
      await writeFile(join(bulkDirectory, `tracked-${suffix}-${outputPadding}.md`), "tracked\n", "utf8");
    }
    await commitFixtureChanges(workspacePath, "add oversized tracked catalog");

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("blocked");
    const freshnessCheck = checkWithId(report, "index-freshness");
    expect(freshnessCheck.status).toBe("blocked");
    expect(Buffer.byteLength(freshnessCheck.observation, "utf8")).toBeLessThanOrEqual(2_048);
    expect(checkWithId(report, "markdown-links").status).toBe("blocked");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("passed");
  }, 45_000);

  it("reports workspace changes created by a build script in the final working-tree check", async () => {
    const workspacePath = await createRepositoryFixture({
      buildCommand: "node -e \"require('node:fs').writeFileSync('generated-by-build.txt', 'generated\\n')\"",
    });

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("unhealthy");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("passed");
    expect(checkWithId(report, "working-tree-final")).toEqual({
      id: "working-tree-final",
      status: "failed",
      observation: expect.stringContaining("generated-by-build.txt"),
    });
  }, 20_000);

  it("fails tracked Markdown links for missing and out-of-root targets but still runs build and test", async () => {
    const workspacePath = await createRepositoryFixture({
      nestedWorkspace: true,
      markdown: [
        "[missing](missing.md)",
        "[outside](../../outside.md)",
      ].join("\n"),
    });
    await writeFile(resolve(workspacePath, "..", "outside.md"), "outside-target-content-must-not-be-read\n", "utf8");

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("unhealthy");
    expect(checkWithId(report, "markdown-links").status).toBe("failed");
    expect(checkWithId(report, "markdown-links").observation).toContain("docs/links.md");
    expect(checkWithId(report, "markdown-links").observation).toContain("missing.md");
    expect(checkWithId(report, "markdown-links").observation).toContain("../outside.md");
    expect(checkWithId(report, "markdown-links").observation).not.toContain("outside-target-content-must-not-be-read");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("passed");
  });

  it("rejects a tracked Markdown source symlink outside the repository without reading external content", async () => {
    const workspacePath = await createRepositoryFixture({ sourceSymlinkOutside: true });

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("unhealthy");
    const markdownLinksCheck = checkWithId(report, "markdown-links");
    expect(markdownLinksCheck.status).toBe("failed");
    expect(markdownLinksCheck.observation).toContain("docs/external/external.md");
    expect(markdownLinksCheck.observation).not.toContain("external-content-must-not-be-read");
    expect(markdownLinksCheck.observation).not.toContain("missing-external-target.md");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("passed");
  }, 20_000);

  it("reports build and test command failures independently with redacted diagnostics", async () => {
    const workspacePath = await createRepositoryFixture({
      buildCommand: "node -e \"console.error('token=super-secret'); process.exit(1)\"",
      testCommand: "node -e \"process.stdout.write('test ok')\"",
    });

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("unhealthy");
    const buildCheck = checkWithId(report, "build");
    expect(buildCheck.status).toBe("failed");
    expect(buildCheck.observation).toContain("[REDACTED]");
    expect(buildCheck.observation).not.toContain("super-secret");
    expect(checkWithId(report, "test").status).toBe("passed");
  });

  it("bounds a timed-out test command without suppressing the build check", async () => {
    const workspacePath = await createRepositoryFixture({
      testCommand: "node -e \"setTimeout(() => {}, 10000)\"",
    });

    const report = await runRepositoryHealthCheck({ workspacePath, timeoutMs: 3_000 });

    expect(report.status).toBe("unhealthy");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("failed");
    expect(checkWithId(report, "test").observation).toMatch(/timed out/i);
  }, 20_000);

  it("uses the default timeout while inspecting a real repository", async () => {
    const workspacePath = await createRepositoryFixture();

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("healthy");
    expect(report.checks.every((check) => check.status === "passed")).toBe(true);
  });

  it("allows the default health check to complete a build longer than the former five-second budget", async () => {
    const workspacePath = await createRepositoryFixture({
      buildCommand: "node -e \"setTimeout(() => {}, 6000)\"",
    });

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("healthy");
    expect(checkWithId(report, "build").status).toBe("passed");
    expect(checkWithId(report, "test").status).toBe("passed");
  }, 30_000);

  it("allows normal test logs slightly above the former output limit", async () => {
    const workspacePath = await createRepositoryFixture({
      testCommand: "node -e \"process.stdout.write('x'.repeat(5 * 1024))\"",
    });

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("healthy");
    expect(checkWithId(report, "test").status).toBe("passed");
  }, 20_000);

  it("bounds a slow Git status command with an explicit timeout", async () => {
    const workspacePath = await createRepositoryFixture();
    const fsMonitorPath = join(workspacePath, "slow-fsmonitor");
    await writeFile(fsMonitorPath, "#!/bin/sh\nsleep 8\necho 0\n", "utf8");
    await chmod(fsMonitorPath, 0o755);
    await git(workspacePath, ["config", "core.fsmonitor", "slow-fsmonitor"]);
    const originalPath = process.env.PATH;
    process.env.PATH = `${workspacePath}${delimiter}${originalPath ?? ""}`;

    try {
      const report = await runRepositoryHealthCheck({ workspacePath, timeoutMs: 5_000 });

      expect(report.status).toBe("blocked");
      expect(checkWithId(report, "working-tree").status).toBe("blocked");
      expect(checkWithId(report, "working-tree").observation).toMatch(/timed out/i);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  }, 40_000);

  it("reports a dirty repository as unhealthy with a failed working-tree check", async () => {
    const workspacePath = await createRepositoryFixture();
    await writeFile(join(workspacePath, "README.md"), "changed\n", "utf8");

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("unhealthy");
    expect(checkWithId(report, "repository-identity").status).toBe("passed");
    expect(checkWithId(report, "working-tree").status).toBe("failed");
    expect(checkWithId(report, "working-tree").observation).toContain("README.md");
    expect(checkWithId(report, "required-files").status).toBe("passed");
  });

  it("blocks an uninspectable non-Git workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-repository-health-non-git-"));
    temporaryRoots.push(workspacePath);

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("blocked");
    expect(checkWithId(report, "repository-identity").status).toBe("blocked");
    expect(report.checks.map((check) => check.id)).not.toContain("working-tree");
    expect(report.checks.map((check) => check.id)).not.toContain("required-files");
  });

  it.each(requiredFiles)("blocks when required file %s is missing", async (relativePath) => {
    const workspacePath = await createRepositoryFixture();
    await rm(join(workspacePath, relativePath));

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("blocked");
    const requiredFilesCheck = checkWithId(report, "required-files");
    expect(requiredFilesCheck.status).toBe("blocked");
    expect(requiredFilesCheck.observation).toContain(relativePath);
  });

  it.each(["", "   "]) ("blocks an %s workspace path without inspecting the current directory", async (workspacePath) => {
    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("blocked");
    expect(report.checks).toEqual([
      expect.objectContaining({ id: "repository-identity", status: "blocked" }),
    ]);
  });

  it("blocks when a required repository file is missing", async () => {
    const workspacePath = await createRepositoryFixture();
    await rm(join(workspacePath, "README.md"));

    const report = await runRepositoryHealthCheck({ workspacePath });

    expect(report.status).toBe("blocked");
    expect(checkWithId(report, "working-tree").status).toBe("failed");
    expect(checkWithId(report, "required-files").status).toBe("blocked");
    expect(checkWithId(report, "required-files").observation).toContain("README.md");
    expect(report.checks.map((check) => check.id)).not.toContain("markdown-links");
    expect(report.checks.map((check) => check.id)).not.toContain("build");
    expect(report.checks.map((check) => check.id)).not.toContain("test");
  });

  it("exposes a JSON healthy report through the npm health-check script", async () => {
    const workspacePath = await createRepositoryFixture();
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const argumentsList = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm.cmd", "run", "--silent", "health-check", "--", "--workspace", workspacePath]
      : ["run", "--silent", "health-check", "--", "--workspace", workspacePath];

    const result = await runCommand({ command, arguments: argumentsList, cwd: process.cwd(), timeoutMs: 20_000 });

    expect(JSON.parse(result.stdout)).toMatchObject({ status: "healthy" });
    expect(result.stderr).toBe("");
  }, 30_000);
});
