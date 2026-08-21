import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  RepositoryHealthPathTraversalError,
  RepositoryHealthTextDecodingError,
} from "../../src/health/repository-health-check.js";
import { scanSecrets } from "../../src/health/secret-scan.js";
import { runRepositoryHealthCheck } from "../../src/health/repository-health-check.js";
import type { RepositoryHealthCheckInput } from "../../src/health/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "secret-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("secret-like content health check", () => {
  test("reports private keys, token-like credentials, API keys, passwords, and secret assignments without values or cyclic duplicates", async () => {
    const repositoryRoot = await createRepository();
    const scanDirectory = join(repositoryRoot, "scan");
    const privateKey = "-----BEGIN PRIVATE KEY-----";
    const githubToken = "ghp_1234567890abcdefghijklmnopqr";
    const apiKey = "sk_live_1234567890abcdefghijklmnop";
    const password = "CorrectHorseBatteryStaple123";
    const secret = "prod_secret_value_1234567890";
    await mkdir(scanDirectory);
    await writeFile(
      join(scanDirectory, "credentials.txt"),
      `${privateKey}\nTOKEN=${githubToken}\napi_key: ${apiKey}\npassword=${password}\nAPP_SECRET=${secret}\n`,
      "utf8",
    );
    await symlink(scanDirectory, join(scanDirectory, "cycle"), "junction");

    const findings = await scanSecrets(repositoryRoot, ["scan"]);

    expect(findings).toEqual([
      { checkId: "secret", severity: "warning", relativePath: "scan/credentials.txt", line: 1, message: "Secret-like content detected (private-key)" },
      { checkId: "secret", severity: "warning", relativePath: "scan/credentials.txt", line: 2, message: "Secret-like content detected (token)" },
      { checkId: "secret", severity: "warning", relativePath: "scan/credentials.txt", line: 3, message: "Secret-like content detected (api-key)" },
      { checkId: "secret", severity: "warning", relativePath: "scan/credentials.txt", line: 4, message: "Secret-like content detected (password)" },
      { checkId: "secret", severity: "warning", relativePath: "scan/credentials.txt", line: 5, message: "Secret-like content detected (secret-assignment)" },
    ]);
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(githubToken);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain(secret);
  });

  test("reports credential-shaped placeholder words while ignoring safe prose and structural documentation placeholders", async () => {
    const repositoryRoot = await createRepository();
    const credentialShapedValue = "prod_test_secret_1234567890";
    const safeContent = [
      `APP_SECRET=${credentialShapedValue}`,
      "Use API_KEY=replace-me in local documentation.",
      "APP_SECRET=replace_me_placeholder",
      "APP_SECRET=example_secret_value",
      "APP_SECRET=dummy_secret_value",
      "APP_SECRET=test_secret_value",
      "APP_SECRET=redacted_secret_value",
      "PASSWORD=your_password_here",
      "The SHA256 hash is 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.",
      "Request id: 123e4567-e89b-12d3-a456-426614174000",
      "Passwords should be stored in a password manager.",
      "Example token: <your-token-here>",
    ].join("\n");
    await writeFile(join(repositoryRoot, "safe.md"), safeContent, "utf8");

    const findings = await scanSecrets(repositoryRoot, ["safe.md"]);

    expect(findings).toEqual([
      {
        checkId: "secret",
        severity: "warning",
        relativePath: "safe.md",
        line: 1,
        message: "Secret-like content detected (secret-assignment)",
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain(credentialShapedValue);
  });

  test("only scans explicit UTF-8 text candidates and never executes content", async () => {
    const repositoryRoot = await createRepository();
    await writeFile(join(repositoryRoot, "script.js"), "throw new Error('must not execute');\n", "utf8");
    await writeFile(join(repositoryRoot, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(repositoryRoot, "ignored.txt"), "TOKEN=ghp_1234567890abcdefghijklmnopqr\n", "utf8");

    await expect(scanSecrets(repositoryRoot, ["script.js", "binary.bin"])).resolves.toEqual([]);
    await expect(readFile(join(repositoryRoot, "script.js"), "utf8")).resolves.toContain("must not execute");
  });

  test("reports standalone GitHub and OpenAI token contracts with redacted findings", async () => {
    const repositoryRoot = await createRepository();
    const secretValues = [
      `github_pat_${"g".repeat(30)}`,
      `sk-proj-${"h".repeat(20)}`,
      `sk-${"i".repeat(20)}`,
    ];
    await writeFile(join(repositoryRoot, "tokens.txt"), secretValues.join("\n") + "\n", "utf8");

    const findings = await scanSecrets(repositoryRoot, ["tokens.txt"]);
    const serialized = JSON.stringify(findings);

    expect(findings).toEqual([
      { checkId: "secret", severity: "warning", relativePath: "tokens.txt", line: 1, message: "Secret-like content detected (token)" },
      { checkId: "secret", severity: "warning", relativePath: "tokens.txt", line: 2, message: "Secret-like content detected (token)" },
      { checkId: "secret", severity: "warning", relativePath: "tokens.txt", line: 3, message: "Secret-like content detected (token)" },
    ]);
    for (const secretValue of secretValues) expect(serialized).not.toContain(secretValue);
  });

  test("fails explicitly on invalid UTF-8 bytes", async () => {
    const repositoryRoot = await createRepository();
    await writeFile(join(repositoryRoot, "invalid.txt"), Buffer.from([0xc3, 0x28]));

    await expect(scanSecrets(repositoryRoot, ["invalid.txt"])).rejects.toBeInstanceOf(
      RepositoryHealthTextDecodingError,
    );
  });

  test("skips excluded secret directory trees", async () => {
    const repositoryRoot = await createRepository();
    const token = `github_pat_${"j".repeat(30)}`;
    for (const excludedDirectory of [".git", "node_modules", "coverage", "build", "dist", ".superpowers"]) {
      const ignoredDirectory = join(repositoryRoot, excludedDirectory, "nested");
      await mkdir(ignoredDirectory, { recursive: true });
      await writeFile(join(ignoredDirectory, "credentials.txt"), `${token}\n`, "utf8");
    }

    await expect(scanSecrets(repositoryRoot, ["."])).resolves.toEqual([]);
  });

  test("rejects nested outside-root secret scan symlinks", async () => {
    const repositoryRoot = await createRepository();
    const outsideDirectory = await createRepository();
    await mkdir(join(repositoryRoot, "scan"));
    await writeFile(join(outsideDirectory, "credentials.txt"), `github_pat_${"k".repeat(30)}\n`, "utf8");
    await symlink(outsideDirectory, join(repositoryRoot, "scan", "outside"), "junction");

    await expect(scanSecrets(repositoryRoot, ["scan"])).rejects.toBeInstanceOf(
      RepositoryHealthPathTraversalError,
    );
  });

  test("aggregator runs enabled secret checks and skips disabled secret checks", async () => {
    const repositoryRoot = await createRepository();
    const token = "ghp_1234567890abcdefghijklmnopqr";
    await writeFile(join(repositoryRoot, "credentials.txt"), `TOKEN=${token}\n`, "utf8");
    const baseInput: RepositoryHealthCheckInput = { repositoryRoot, scan: { enabledChecks: [], candidatePaths: ["credentials.txt"] } };

    await expect(runRepositoryHealthCheck({ ...baseInput, scan: { ...baseInput.scan, enabledChecks: ["secret"] } })).resolves.toMatchObject({
      healthy: false,
      findings: [{ checkId: "secret", relativePath: "credentials.txt", line: 1 }],
    });
    await expect(runRepositoryHealthCheck(baseInput)).resolves.toMatchObject({ healthy: true, findings: [] });
  });
});
