import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityMismatchError, InvalidTaskStateError } from "../../src/domain/errors.js";
import type { SkillDescriptor } from "../../src/skills/registry.js";
import { discoverSkillMetadata, selectCapabilities } from "../../src/skills/registry.js";

const fixtureRoot = join(process.cwd(), "tests", "fixtures", "skills");
const temporaryDirectories: string[] = [];

async function createTemporarySkillRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "d-ai-skills-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("discoverSkillMetadata", () => {
  it("discovers only frontmatter and returns absolute normalized Skill paths", async () => {
    const descriptors = await discoverSkillMetadata([fixtureRoot]);

    expect(descriptors).toEqual([
      expect.objectContaining({ name: "typescript-execution", skillPath: join(fixtureRoot, "typescript-execution", "SKILL.md") }),
      expect.objectContaining({ name: "unrelated-planning", skillPath: join(fixtureRoot, "unrelated-planning", "SKILL.md") }),
      expect.objectContaining({ name: "verification-execution", skillPath: join(fixtureRoot, "verification-execution", "SKILL.md") }),
    ]);
    expect(JSON.stringify(descriptors)).not.toContain("THIS BODY MUST NOT BE DISCOVERED");
    expect(JSON.stringify(descriptors)).not.toContain("THIS RESOURCE MUST NOT BE DISCOVERED");
  });

  it("discovers frontmatter without loading oversized bodies or resources", async () => {
    const oversizedRoot = await createTemporarySkillRoot();
    const skillDirectory = join(oversizedRoot, "metadata-only");
    await mkdir(join(skillDirectory, "references"), { recursive: true });
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      "---\nname: metadata-only\ndescription: Discovers metadata only.\ntriggers:\n  - metadata\ncompatibleEnvironments:\n  - codex\ncompatibleStages:\n  - inspect\n---\n" + "x".repeat(1_048_577),
      "utf8",
    );
    await writeFile(join(skillDirectory, "references", "oversized.md"), "y".repeat(1_048_577), "utf8");

    await expect(discoverSkillMetadata([oversizedRoot])).resolves.toEqual([
      expect.objectContaining({ name: "metadata-only", compatibleStages: ["inspect"] }),
    ]);
  });

  it("rejects malformed metadata, unsafe paths, and duplicate Skill names", async () => {
    const malformedRoot = await createTemporarySkillRoot();
    await mkdir(join(malformedRoot, "wrong-name"));
    await writeFile(
      join(malformedRoot, "wrong-name", "SKILL.md"),
      "---\nname: correct-name\ndescription: Valid description\ntriggers:\n  - execute\ncompatibleEnvironments:\n  - codex\n---\n",
      "utf8",
    );
    await expect(discoverSkillMetadata([malformedRoot])).rejects.toThrow(InvalidTaskStateError);

    const duplicateRoot = await createTemporarySkillRoot();
    await cp(join(fixtureRoot, "typescript-execution"), join(duplicateRoot, "typescript-execution"), { recursive: true });
    await expect(discoverSkillMetadata([fixtureRoot, duplicateRoot])).rejects.toThrowError("Duplicate Skill name: typescript-execution.");
    await expect(discoverSkillMetadata([join(malformedRoot, "missing-root")])).rejects.toThrow(InvalidTaskStateError);
  });

  it("requires unique known compatible stages", async () => {
    const invalidStageRoot = await createTemporarySkillRoot();
    const invalidStageDirectory = join(invalidStageRoot, "invalid-stage");
    await mkdir(invalidStageDirectory);
    await writeFile(
      join(invalidStageDirectory, "SKILL.md"),
      "---\nname: invalid-stage\ndescription: Has an invalid stage.\ntriggers:\n  - invalid\ncompatibleEnvironments:\n  - codex\ncompatibleStages:\n  - unknown\n---\n",
      "utf8",
    );
    await expect(discoverSkillMetadata([invalidStageRoot])).rejects.toThrow(InvalidTaskStateError);

    const duplicateStageRoot = await createTemporarySkillRoot();
    const duplicateStageDirectory = join(duplicateStageRoot, "duplicate-stage");
    await mkdir(duplicateStageDirectory);
    await writeFile(
      join(duplicateStageDirectory, "SKILL.md"),
      "---\nname: duplicate-stage\ndescription: Has duplicate stages.\ntriggers:\n  - duplicate\ncompatibleEnvironments:\n  - codex\ncompatibleStages:\n  - execute\n  - execute\n---\n",
      "utf8",
    );
    await expect(discoverSkillMetadata([duplicateStageRoot])).rejects.toThrow(InvalidTaskStateError);
  });
});

describe("selectCapabilities", () => {
  it("returns the deterministic minimum compatible set covering the matched intent", async () => {
    const descriptors = await discoverSkillMetadata([fixtureRoot]);

    expect(selectCapabilities("implement typescript and verify evidence", "execute", "codex", descriptors).map((descriptor) => descriptor.name)).toEqual([
      "typescript-execution",
      "verification-execution",
    ]);
    expect(selectCapabilities("plan campaign", "plan", "codex", descriptors)).toEqual([]);
  });

  it("uses compatibleStages rather than intent triggers for stage eligibility", async () => {
    const descriptors = await discoverSkillMetadata([fixtureRoot]);

    expect(selectCapabilities("implement typescript", "execute", "codex", descriptors).map((descriptor) => descriptor.name)).toEqual([
      "typescript-execution",
    ]);
    expect(selectCapabilities("implement typescript", "plan", "codex", descriptors)).toEqual([]);
  });

  it("does not mutate descriptor inputs and rejects invalid descriptor ambiguity", async () => {
    const descriptors = await discoverSkillMetadata([fixtureRoot]);
    const before = JSON.stringify(descriptors);

    selectCapabilities("implement typescript", "execute", "codex", descriptors);

    expect(JSON.stringify(descriptors)).toBe(before);
    const duplicate: SkillDescriptor = { ...descriptors[0]! };
    expect(() => selectCapabilities("implement", "execute", "codex", [descriptors[0]!, duplicate])).toThrow(CapabilityMismatchError);
  });
});
