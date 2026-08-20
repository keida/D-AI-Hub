import { copyFile, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InvalidTaskStateError } from "../../src/domain/errors.js";
import { discoverSkillMetadata } from "../../src/skills/registry.js";
import { loadSelectedSkill } from "../../src/skills/skill-loader.js";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "skills");
const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "d-ai-skill-loader-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("loadSelectedSkill", () => {
  it("loads selected instructions and only explicitly requested resources", async () => {
    const descriptors = await discoverSkillMetadata([fixtureRoot]);
    const descriptor = descriptors.find((candidate) => candidate.name === "typescript-execution");
    if (descriptor === undefined) {
      throw new Error("Expected typescript-execution fixture descriptor");
    }

    const loaded = await loadSelectedSkill(descriptor, ["references/workflow.md"]);

    expect(loaded.descriptor).toEqual(descriptor);
    expect(loaded.instructions).toContain("Use the selected implementation workflow.");
    expect(loaded.loadedResources).toEqual([join(fixtureRoot, "typescript-execution", "references", "workflow.md")]);
  });

  it("rejects traversal, duplicate, and missing resource requests", async () => {
    const descriptors = await discoverSkillMetadata([fixtureRoot]);
    const descriptor = descriptors.find((candidate) => candidate.name === "typescript-execution");
    if (descriptor === undefined) {
      throw new Error("Expected typescript-execution fixture descriptor");
    }

    await expect(loadSelectedSkill(descriptor, ["../unrelated-planning/SKILL.md"])).rejects.toThrow(InvalidTaskStateError);
    await expect(loadSelectedSkill(descriptor, ["references/workflow.md", "references/workflow.md"])).rejects.toThrow(
      InvalidTaskStateError,
    );
    await expect(loadSelectedSkill(descriptor, ["references/missing.md"])).rejects.toThrow(InvalidTaskStateError);
  });

  it("rejects a symbolic-link resource before reading it", async () => {
    const descriptors = await discoverSkillMetadata([fixtureRoot]);
    const descriptor = descriptors.find((candidate) => candidate.name === "typescript-execution");
    if (descriptor === undefined) {
      throw new Error("Expected typescript-execution fixture descriptor");
    }
    const temporaryDirectory = await createTemporaryDirectory();
    const linkPath = join(temporaryDirectory, "references");
    await symlink(join(fixtureRoot, "unrelated-planning", "references"), linkPath, "junction");
    const linkedDescriptor = { ...descriptor, skillPath: join(temporaryDirectory, "SKILL.md") };
    await copyFile(descriptor.skillPath, linkedDescriptor.skillPath);

    await expect(loadSelectedSkill(linkedDescriptor, ["references/notes.md"])).rejects.toThrow(InvalidTaskStateError);
  });
});
