import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  RepositoryHealthPathTraversalError,
  RepositoryHealthTextDecodingError,
  runRepositoryHealthCheck,
} from "../../src/health/repository-health-check.js";
import type { RepositoryHealthCheckInput } from "../../src/health/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "markdown-links-"));
  temporaryDirectories.push(directory);
  return directory;
}

function input(repositoryRoot: string, candidatePaths: readonly string[]): RepositoryHealthCheckInput {
  return { repositoryRoot, scan: { enabledChecks: ["link"], candidatePaths } };
}

describe("Markdown link health check", () => {
  test("accepts valid local links and ignores anchors and external links", async () => {
    const repositoryRoot = await createRepository();
    await writeFile(join(repositoryRoot, "target.md"), "target\n", "utf8");
    await writeFile(join(repositoryRoot, "image.bin"), Buffer.from([0xff, 0xd8, 0xff]));
    await writeFile(
      join(repositoryRoot, "README.md"),
      "[local](target.md#section) [binary](image.bin) [anchor](#top) [web](https://example.com) [mail](mailto:a@example.com)\n",
      "utf8",
    );

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ["README.md", "target.md"]))).resolves.toMatchObject({
      healthy: true,
      findings: [],
    });
  });

  test("reports missing local targets with source path and line", async () => {
    const repositoryRoot = await createRepository();
    await writeFile(join(repositoryRoot, "README.md"), "ok\n[missing](missing.md)\n", "utf8");

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ["README.md"]))).resolves.toMatchObject({
      healthy: false,
      findings: [
        {
          checkId: "link",
          severity: "error",
          relativePath: "README.md",
          line: 2,
          message: "Missing local Markdown link target: missing.md",
        },
      ],
    });
  });

  test("reports direct and symlink traversal without reading outside the root", async () => {
    const repositoryRoot = await createRepository();
    const outsideDirectory = await createRepository();
    await writeFile(join(outsideDirectory, "secret.txt"), "do not read\n", "utf8");
    await symlink(outsideDirectory, join(repositoryRoot, "outside-directory"), "junction");
    await writeFile(
      join(repositoryRoot, "README.md"),
      "[direct](../outside.txt)\n[symlink](outside-directory/secret.txt)\n[script](run.js)\n",
      "utf8",
    );
    await writeFile(join(repositoryRoot, "run.js"), "throw new Error('must not execute');\n", "utf8");

    const report = await runRepositoryHealthCheck(input(repositoryRoot, ["README.md", "run.js"]));

    expect(report.findings).toEqual([
      {
        checkId: "link",
        severity: "error",
        relativePath: "README.md",
        line: 1,
        message: "Unsafe local Markdown link target: ../outside.txt",
      },
      {
        checkId: "link",
        severity: "error",
        relativePath: "README.md",
        line: 2,
        message: "Unsafe local Markdown link target: outside-directory/secret.txt",
      },
    ]);
  });

  test("terminates in-root Markdown directory cycles and skips excluded directory trees", async () => {
    const repositoryRoot = await createRepository();
    const docsDirectory = join(repositoryRoot, "docs");
    await mkdir(docsDirectory);
    await writeFile(join(docsDirectory, "README.md"), "[missing](missing.md)\n", "utf8");
    await symlink(docsDirectory, join(docsDirectory, "cycle"), "junction");
    for (const excludedDirectory of [".git", "node_modules", "coverage", "build", "dist", ".superpowers"]) {
      const ignoredDirectory = join(repositoryRoot, excludedDirectory, "nested");
      await mkdir(ignoredDirectory, { recursive: true });
      await writeFile(join(ignoredDirectory, "ignored.md"), "[ignored](missing.md)\n", "utf8");
    }

    const report = await runRepositoryHealthCheck(input(repositoryRoot, ["."]));

    expect(report.findings).toEqual([
      {
        checkId: "link",
        severity: "error",
        relativePath: "docs/README.md",
        line: 1,
        message: "Missing local Markdown link target: missing.md",
      },
    ]);
  });

  test("rejects nested outside-root Markdown symlinks and redacts their secret-shaped filenames", async () => {
    const repositoryRoot = await createRepository();
    const outsideDirectory = await createRepository();
    const secretName = `github_pat_${"a".repeat(30)}`;
    await mkdir(join(repositoryRoot, "docs"));
    await writeFile(join(outsideDirectory, "outside.md"), "outside\n", "utf8");
    await symlink(outsideDirectory, join(repositoryRoot, "docs", secretName), "junction");

    const result = runRepositoryHealthCheck(input(repositoryRoot, ["docs"]));

    await expect(result).rejects.toBeInstanceOf(RepositoryHealthPathTraversalError);
    await expect(result).rejects.not.toThrow(secretName);
  });

  test("redacts secret-shaped Markdown source filenames and local link targets from serialized reports", async () => {
    const repositoryRoot = await createRepository();
    const sourceSecret = `github_pat_${"b".repeat(30)}`;
    const targetSecret = `sk-proj-${"c".repeat(20)}`;
    await writeFile(join(repositoryRoot, `${sourceSecret}.md`), `[missing](${targetSecret}.md)\n`, "utf8");

    const report = await runRepositoryHealthCheck(input(repositoryRoot, [`${sourceSecret}.md`]));
    const serialized = JSON.stringify(report);

    expect(report.healthy).toBe(false);
    expect(serialized).not.toContain(sourceSecret);
    expect(serialized).not.toContain(targetSecret);
  });

  test("rejects invalid Markdown bytes with a typed fatal UTF-8 error", async () => {
    const repositoryRoot = await createRepository();
    await writeFile(join(repositoryRoot, "invalid.md"), Buffer.from([0xc3, 0x28]));

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ["invalid.md"]))).rejects.toBeInstanceOf(
      RepositoryHealthTextDecodingError,
    );
    await expect(runRepositoryHealthCheck(input(repositoryRoot, ["invalid.md"]))).rejects.toMatchObject({
      name: "RepositoryHealthTextDecodingError",
      message: "Invalid UTF-8 text file: invalid.md",
    });
  });
});
