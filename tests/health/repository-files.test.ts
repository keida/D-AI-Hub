import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { collectRepositoryFiles } from "../../src/health/repository-files.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "repository-files-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("repository file collection", () => {
  test("skips in-repository symlink aliases that canonicalize into excluded directories", async () => {
    const repositoryRoot = await createRepository();
    const excludedDirectory = join(repositoryRoot, "node_modules", "dependency");
    const aliasParent = join(repositoryRoot, "docs");
    await mkdir(excludedDirectory, { recursive: true });
    await mkdir(aliasParent, { recursive: true });
    await writeFile(join(excludedDirectory, "secret.txt"), "must not be scanned", "utf8");
    await symlink(excludedDirectory, join(aliasParent, "cache"), "junction");

    await expect(collectRepositoryFiles(repositoryRoot, ["docs/cache/secret.txt"])).resolves.toEqual([]);
  });
});
