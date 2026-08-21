import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const unreadableCandidate = vi.hoisted((): { readonly paths: Set<string> } => ({ paths: new Set<string>() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (...arguments_: Parameters<typeof actual.readFile>) => {
      const candidatePath = arguments_[0];
      if (typeof candidatePath === "string" && unreadableCandidate.paths.has(candidatePath)) {
        throw Object.assign(new Error(`Permission denied: ${candidatePath}`), { code: "EACCES" });
      }
      return actual.readFile(...arguments_);
    }) as typeof actual.readFile,
  };
});

import { normalizeIndexTargetPath } from "../../src/health/index-freshness.js";
import { runRepositoryHealthCheck } from "../../src/health/repository-health-check.js";
import type { RepositoryHealthCheckInput } from "../../src/health/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  unreadableCandidate.paths.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "index-freshness-"));
  temporaryDirectories.push(directory);
  return directory;
}

function input(repositoryRoot: string, enabledChecks: readonly ("index" | "link")[]): RepositoryHealthCheckInput {
  return { repositoryRoot, scan: { enabledChecks, candidatePaths: ["indexes"] } };
}

describe("Index freshness health check", () => {
  test("normalizes duplicate index targets relative to the containing document directory", () => {
    const documentPath = join("repository", "indexes", "SKILLS.md");

    expect(normalizeIndexTargetPath(documentPath, "../knowledge/note.md")).toBe(
      resolve("repository", "knowledge", "note.md"),
    );
  });

  test("reports missing index targets and duplicate normalized canonical entries", async () => {
    const repositoryRoot = await createRepository();
    await mkdir(join(repositoryRoot, "indexes"));
    await mkdir(join(repositoryRoot, "knowledge"));
    await writeFile(join(repositoryRoot, "knowledge", "note.md"), "note\n", "utf8");
    await writeFile(
      join(repositoryRoot, "indexes", "SKILLS.md"),
      "[first](../knowledge/note.md)\n[duplicate](../knowledge/./note.md)\n[missing](../knowledge/missing.md)\n",
      "utf8",
    );

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ["index"]))).resolves.toMatchObject({
      healthy: false,
      findings: [
        {
          checkId: "index",
          severity: "error",
          relativePath: "indexes/SKILLS.md",
          line: 2,
          message: "Duplicate canonical index target: ../knowledge/./note.md",
        },
        {
          checkId: "index",
          severity: "error",
          relativePath: "indexes/SKILLS.md",
          line: 3,
          message: "Missing local index target: ../knowledge/missing.md",
        },
      ],
    });
  });

  test("does not require absent index files and does not run disabled checks", async () => {
    const repositoryRoot = await createRepository();
    await mkdir(join(repositoryRoot, "indexes"));
    await writeFile(join(repositoryRoot, "indexes", "PROJECTS.md"), "[missing](missing.md)\n", "utf8");

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ["index"]))).resolves.toMatchObject({
      findings: [
        {
          checkId: "index",
          relativePath: "indexes/PROJECTS.md",
        },
      ],
    });
    await expect(runRepositoryHealthCheck(input(repositoryRoot, []))).resolves.toEqual({
      healthy: true,
      findings: [],
      summary: { total: 0, errors: 0, warnings: 0 },
    });
  });

  test("ignores ordinary Markdown files when the candidate inventory includes canonical indexes", async () => {
    const repositoryRoot = await createRepository();
    await mkdir(join(repositoryRoot, "indexes"));
    await writeFile(join(repositoryRoot, "README.md"), "[ordinary missing link](missing.md)\n", "utf8");
    await writeFile(join(repositoryRoot, "indexes", "SKILLS.md"), "[valid](../README.md)\n", "utf8");

    await expect(
      runRepositoryHealthCheck({
        repositoryRoot,
        scan: {
          enabledChecks: ["index"],
          candidatePaths: ["README.md", "indexes"],
        },
      }),
    ).resolves.toEqual({
      healthy: true,
      findings: [],
      summary: { total: 0, errors: 0, warnings: 0 },
    });
  });

  test("does not read an unreadable ordinary Markdown candidate in index-only mode", async () => {
    const repositoryRoot = await createRepository();
    await mkdir(join(repositoryRoot, "indexes"));
    await writeFile(join(repositoryRoot, "README.md"), "referenced target\n", "utf8");
    const ordinaryMarkdownPath = join(repositoryRoot, "ordinary-unreadable.md");
    await writeFile(ordinaryMarkdownPath, "ordinary\n", "utf8");
    await writeFile(join(repositoryRoot, "indexes", "SKILLS.md"), "[valid](../README.md)\n", "utf8");
    unreadableCandidate.paths.add(ordinaryMarkdownPath);

    await expect(
      runRepositoryHealthCheck({
        repositoryRoot,
        scan: {
          enabledChecks: ["index"],
          candidatePaths: ["ordinary-unreadable.md", "indexes/SKILLS.md"],
        },
      }),
    ).resolves.toEqual({
      healthy: true,
      findings: [],
      summary: { total: 0, errors: 0, warnings: 0 },
    });
  });

  test("redacts secret-shaped missing and duplicate index targets from serialized reports", async () => {
    const repositoryRoot = await createRepository();
    const duplicateSecret = `sk-${"d".repeat(20)}`;
    const missingSecret = `github_pat_${"e".repeat(30)}`;
    await mkdir(join(repositoryRoot, "indexes"));
    await mkdir(join(repositoryRoot, "knowledge"));
    await writeFile(join(repositoryRoot, "knowledge", `${duplicateSecret}.md`), "note\n", "utf8");
    await writeFile(
      join(repositoryRoot, "indexes", "SKILLS.md"),
      `[first](../knowledge/${duplicateSecret}.md)\n[duplicate](../knowledge/${duplicateSecret}.md)\n[missing](../knowledge/${missingSecret}.md)\n`,
      "utf8",
    );

    const report = await runRepositoryHealthCheck(input(repositoryRoot, ["index"]));
    const serialized = JSON.stringify(report);

    expect(report.healthy).toBe(false);
    expect(serialized).not.toContain(duplicateSecret);
    expect(serialized).not.toContain(missingSecret);
  });
});
