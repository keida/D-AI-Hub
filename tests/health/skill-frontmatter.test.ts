import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RepositoryHealthPathTraversalError } from "../../src/health/repository-health-check.js";
import { scanSkillFrontmatter } from "../../src/health/skill-frontmatter.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "skill-frontmatter-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createSkill(repositoryRoot: string, relativeDirectory: string, content: string): Promise<void> {
  const directory = join(repositoryRoot, relativeDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content, "utf8");
}

describe("Skill frontmatter health check", () => {
  test("accepts valid canonical and compatibility Skill files from the candidate inventory", async () => {
    const repositoryRoot = await createRepository();
    await createSkill(repositoryRoot, "skills/custom/alpha", "---\nname: alpha\ndescription: Alpha skill\n---\nbody\n");
    await createSkill(repositoryRoot, ".agents/skills/alpha", "---\nname: alpha\ndescription: Compatibility entry\n---\n");

    await expect(scanSkillFrontmatter(repositoryRoot, ["skills/custom", ".agents/skills"])).resolves.toEqual([]);
  });

  test("reports missing fields and malformed YAML with redacted typed findings without duplicating cyclic paths", async () => {
    const repositoryRoot = await createRepository();
    const malformedDirectory = join(repositoryRoot, "skills", "custom", "malformed");
    await createSkill(repositoryRoot, "skills/custom/missing", "---\nname: missing\n---\n");
    await createSkill(repositoryRoot, "skills/custom/malformed", "---\nname: [broken\ndescription: bad\n---\n");
    await symlink(malformedDirectory, join(malformedDirectory, "cycle"), "junction");

    await expect(scanSkillFrontmatter(repositoryRoot, ["skills/custom"])).resolves.toEqual([
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/malformed/SKILL.md",
        line: 1,
        message: "Malformed Skill frontmatter",
      },
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/missing/SKILL.md",
        line: 1,
        message: "Skill frontmatter requires non-empty description",
      },
    ]);
  });

  test("reports duplicate canonical Skill names deterministically but does not compare compatibility entries", async () => {
    const repositoryRoot = await createRepository();
    const content = "---\nname: duplicate\ndescription: Skill\n---\n";
    await createSkill(repositoryRoot, "skills/custom/zulu", content);
    await createSkill(repositoryRoot, "skills/custom/alpha", content);
    await createSkill(repositoryRoot, ".agents/skills/duplicate", content);

    await expect(scanSkillFrontmatter(repositoryRoot, ["skills/custom", ".agents/skills"])).resolves.toEqual([
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/alpha/SKILL.md",
        line: 2,
        message: "Canonical Skill directory alpha must match frontmatter name duplicate",
      },
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/alpha/SKILL.md",
        line: 2,
        message: "Duplicate canonical Skill name: duplicate",
      },
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/zulu/SKILL.md",
        line: 2,
        message: "Canonical Skill directory zulu must match frontmatter name duplicate",
      },
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/zulu/SKILL.md",
        line: 2,
        message: "Duplicate canonical Skill name: duplicate",
      },
    ]);
  });

  test("does not inspect Skill files outside the explicit candidate inventory", async () => {
    const repositoryRoot = await createRepository();
    await createSkill(repositoryRoot, "skills/custom/ignored", "not frontmatter\n");
    await createSkill(repositoryRoot, ".agents/skills/included", "---\nname: included\ndescription: Included\n---\n");

    await expect(scanSkillFrontmatter(repositoryRoot, [".agents/skills/included/SKILL.md"])).resolves.toEqual([]);
  });

  test("enforces the registry safe-name pattern and canonical directory-name correspondence", async () => {
    const repositoryRoot = await createRepository();
    await createSkill(repositoryRoot, "skills/custom/unsafe", "---\nname: Unsafe_Name\ndescription: Unsafe\n---\n");
    await createSkill(repositoryRoot, "skills/custom/directory-name", "---\nname: metadata-name\ndescription: Mismatch\n---\n");

    await expect(scanSkillFrontmatter(repositoryRoot, ["skills/custom"])).resolves.toEqual([
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/directory-name/SKILL.md",
        line: 2,
        message: "Canonical Skill directory directory-name must match frontmatter name metadata-name",
      },
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: "skills/custom/unsafe/SKILL.md",
        line: 2,
        message: "Unsafe Skill name: Unsafe_Name",
      },
    ]);
  });

  test("enforces directory-name correspondence for compatibility Skill entries", async () => {
    const repositoryRoot = await createRepository();
    await createSkill(
      repositoryRoot,
      ".agents/skills/alias",
      "---\nname: different-name\ndescription: Compatibility mismatch\n---\n",
    );

    await expect(scanSkillFrontmatter(repositoryRoot, [".agents/skills"])).resolves.toEqual([
      {
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: ".agents/skills/alias/SKILL.md",
        line: 2,
        message: "Compatibility Skill directory alias must match frontmatter name different-name",
      },
    ]);
  });

  test("redacts secret-shaped duplicate Skill names from serialized findings", async () => {
    const repositoryRoot = await createRepository();
    const secretName = `sk-${"f".repeat(20)}`;
    const content = `---\nname: ${secretName}\ndescription: Secret-shaped duplicate\n---\n`;
    await createSkill(repositoryRoot, `skills/custom/${secretName}`, content);
    await createSkill(repositoryRoot, "skills/custom/alias", content);

    const findings = await scanSkillFrontmatter(repositoryRoot, ["skills/custom"]);

    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings)).not.toContain(secretName);
  });

  test("rejects nested outside-root Skill symlinks", async () => {
    const repositoryRoot = await createRepository();
    const outsideDirectory = await createRepository();
    await createSkill(outsideDirectory, "outside-skill", "---\nname: outside-skill\ndescription: Outside\n---\n");
    await mkdir(join(repositoryRoot, "skills", "custom"), { recursive: true });
    await symlink(join(outsideDirectory, "outside-skill"), join(repositoryRoot, "skills", "custom", "outside-skill"), "junction");

    await expect(scanSkillFrontmatter(repositoryRoot, ["skills/custom"])).rejects.toBeInstanceOf(
      RepositoryHealthPathTraversalError,
    );
  });

});
