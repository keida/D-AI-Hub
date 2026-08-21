import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runRepositoryHealthCheck } from "../../src/health/repository-health-check.js";
import type { RepositoryHealthCheckInput, RepositoryHealthReport } from "../../src/health/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeRepositoryFile(repositoryRoot: string, relativePath: string, content: string): Promise<void> {
  const filePath = join(repositoryRoot, relativePath);
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function snapshotRepository(repositoryRoot: string): Promise<Readonly<Record<string, string>>> {
  const entries = new Map<string, string>();

  async function visit(directory: string): Promise<void> {
    const directoryEntries = [...await readdir(directory, { withFileTypes: true })]
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(repositoryRoot, absolutePath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Unexpected fixture entry type: ${relativePath}`);
      entries.set(relativePath, (await readFile(absolutePath)).toString("base64"));
    }
  }

  await visit(repositoryRoot);
  return Object.fromEntries([...entries.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function healthCheckInput(repositoryRoot: string): RepositoryHealthCheckInput {
  return {
    repositoryRoot,
    scan: {
      enabledChecks: ["link", "index", "skill-frontmatter", "secret"],
      candidatePaths: [
        "README.md",
        "docs",
        "indexes",
        "skills/custom",
        ".agents/skills",
        "credentials.txt",
        "execute.js",
      ],
    },
  };
}

async function runTwice(repositoryRoot: string): Promise<readonly [RepositoryHealthReport, RepositoryHealthReport]> {
  const input = healthCheckInput(repositoryRoot);
  const firstReport = await runRepositoryHealthCheck(input);
  const secondReport = await runRepositoryHealthCheck(input);
  return [firstReport, secondReport];
}

async function createValidRepository(): Promise<string> {
  const repositoryRoot = await createRepository("repository-health-integration-valid-");
  await writeRepositoryFile(repositoryRoot, "README.md", "# Fixture\n\n[Guide](docs/guide.md)\n[Anchor](#fixture)\n[External](https://example.com)\n");
  await writeRepositoryFile(repositoryRoot, "docs/guide.md", "# Guide\n\nSafe ordinary documentation.\n");
  await writeRepositoryFile(repositoryRoot, "indexes/SKILLS.md", "[Canonical skill](../skills/custom/alpha/SKILL.md)\n[Compatibility skill](../.agents/skills/alpha/SKILL.md)\n");
  await writeRepositoryFile(repositoryRoot, "indexes/KNOWLEDGE.md", "[Guide](../docs/guide.md)\n");
  await writeRepositoryFile(repositoryRoot, "indexes/PROJECTS.md", "[Repository](../README.md)\n");
  await writeRepositoryFile(repositoryRoot, "skills/custom/alpha/SKILL.md", "---\nname: alpha\ndescription: Canonical alpha skill\n---\nRead-only skill text.\n");
  await writeRepositoryFile(repositoryRoot, ".agents/skills/alpha/SKILL.md", "---\nname: alpha\ndescription: Compatibility alpha entry point\n---\nCompatibility text.\n");
  await writeRepositoryFile(repositoryRoot, "ordinary.txt", "Safe ordinary text.\n");
  await writeRepositoryFile(repositoryRoot, "credentials.txt", "No credentials are present in this clean fixture.\n");
  await writeRepositoryFile(repositoryRoot, "execute.js", "throw new Error(\"This fixture must never be executed\");\n");
  return repositoryRoot;
}

async function createInvalidRepository(): Promise<{ readonly repositoryRoot: string; readonly secretValues: readonly string[] }> {
  const repositoryRoot = await createRepository("repository-health-integration-invalid-");
  const secretValues = [
    "ghp_integration_fixture_token_123456",
    "integration_api_key_1234567890",
    "IntegrationPassword123",
    "integration_secret_value_1234",
  ];
  await writeRepositoryFile(repositoryRoot, "README.md", "# Fixture\n\n[Missing](docs/missing.md)\n");
  await writeRepositoryFile(repositoryRoot, "docs/guide.md", "# Guide\n");
  await writeRepositoryFile(repositoryRoot, "indexes/SKILLS.md", "[Missing index](../docs/missing-index.md)\n[Guide](../docs/guide.md)\n[Guide again](../docs/guide.md)\n");
  await writeRepositoryFile(repositoryRoot, "indexes/KNOWLEDGE.md", "[Guide](../docs/guide.md)\n");
  await writeRepositoryFile(repositoryRoot, "indexes/PROJECTS.md", "[Repository](../README.md)\n");
  await writeRepositoryFile(repositoryRoot, "skills/custom/broken/SKILL.md", "---\nname: broken\n---\nMalformed because description is missing.\n");
  await writeRepositoryFile(repositoryRoot, ".agents/skills/broken/SKILL.md", "---\nname: broken\ndescription: Compatibility entry\n---\n");
  await writeRepositoryFile(repositoryRoot, "credentials.txt", [
    "-----BEGIN PRIVATE KEY-----",
    `TOKEN=${secretValues[0]}`,
    `API_KEY=${secretValues[1]}`,
    `PASSWORD=${secretValues[2]}`,
    `APP_SECRET=${secretValues[3]}`,
  ].join("\n") + "\n");
  await writeRepositoryFile(repositoryRoot, "execute.js", "throw new Error(\"This fixture must never be executed\");\n");
  return { repositoryRoot, secretValues };
}

describe("repository health-check integration", () => {
  test("scans a valid temporary repository deterministically without process or network effects", async () => {
    const repositoryRoot = await createValidRepository();
    const markerPath = join(repositoryRoot, "executed.marker");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const beforeScan = await snapshotRepository(repositoryRoot);

    const [firstReport, secondReport] = await runTwice(repositoryRoot);

    expect(firstReport).toEqual({
      healthy: true,
      findings: [],
      summary: { total: 0, errors: 0, warnings: 0 },
    });
    expect(secondReport).toEqual(firstReport);
    expect(await snapshotRepository(repositoryRoot)).toEqual(beforeScan);
    await expect(stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("reports every invalid-fixture category with stable redacted findings and never executes content", async () => {
    const { repositoryRoot, secretValues } = await createInvalidRepository();
    const beforeScan = await snapshotRepository(repositoryRoot);

    const [firstReport, secondReport] = await runTwice(repositoryRoot);
    const serializedReport = JSON.stringify(firstReport);

    expect(firstReport).toEqual(secondReport);
    expect(firstReport.healthy).toBe(false);
    expect(firstReport.summary).toEqual({ total: 10, errors: 5, warnings: 5 });
    expect(new Set(firstReport.findings.map((finding) => finding.checkId))).toEqual(
      new Set(["link", "index", "skill-frontmatter", "secret"]),
    );
    expect(firstReport.findings.every((finding) => finding.relativePath.length > 0 && finding.line !== undefined)).toBe(true);
    expect(firstReport.findings.map((finding) => finding.message)).toEqual(expect.arrayContaining([
      "Missing local Markdown link target: docs/missing.md",
      "Missing local index target: ../docs/missing-index.md",
      "Duplicate canonical index target: ../docs/guide.md",
      "Skill frontmatter requires non-empty description",
      "Secret-like content detected (private-key)",
      "Secret-like content detected (token)",
      "Secret-like content detected (api-key)",
      "Secret-like content detected (password)",
      "Secret-like content detected (secret-assignment)",
    ]));
    for (const secretValue of secretValues) expect(serializedReport).not.toContain(secretValue);
    expect(serializedReport).not.toContain("This fixture must never be executed");
    expect(await snapshotRepository(repositoryRoot)).toEqual(beforeScan);
  });
});
