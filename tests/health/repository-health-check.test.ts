import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  aggregateRepositoryHealthReport,
  InvalidRepositoryHealthCheckInputError,
  RepositoryHealthPathTraversalError,
  runRepositoryHealthCheck,
} from '../../src/health/repository-health-check.js';
import type {
  HealthFinding,
  RepositoryHealthCheckInput,
} from '../../src/health/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'repository-health-check-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function createFile(repositoryRoot: string): Promise<string> {
  const filePath = join(repositoryRoot, 'not-a-directory.txt');
  await writeFile(filePath, 'content');
  return filePath;
}

function input(repositoryRoot: string, candidatePaths: readonly string[]): RepositoryHealthCheckInput {
  return {
    repositoryRoot,
    scan: {
      enabledChecks: [],
      candidatePaths,
    },
  };
}

describe('runRepositoryHealthCheck', () => {
  test('returns a healthy empty report for a valid empty repository', async () => {
    const repositoryRoot = await createRepository();

    await expect(runRepositoryHealthCheck(input(repositoryRoot, []))).resolves.toEqual({
      healthy: true,
      findings: [],
      summary: {
        total: 0,
        errors: 0,
        warnings: 0,
      },
    });
  });

  test('rejects a candidate path outside the repository root', async () => {
    const repositoryRoot = await createRepository();

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ['../outside.txt']))).rejects.toBeInstanceOf(
      RepositoryHealthPathTraversalError,
    );
    await expect(runRepositoryHealthCheck(input(repositoryRoot, ['../outside.txt']))).rejects.toMatchObject({
      message: 'Candidate path escapes repository root: ../outside.txt',
      name: 'RepositoryHealthPathTraversalError',
    });
  });

  test('rejects an existing candidate symlink that resolves outside the repository root', async () => {
    const repositoryRoot = await createRepository();
    const outsideDirectory = await createRepository();
    await symlink(outsideDirectory, join(repositoryRoot, 'outside-link'), 'junction');

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ['outside-link']))).rejects.toBeInstanceOf(
      RepositoryHealthPathTraversalError,
    );
    await expect(runRepositoryHealthCheck(input(repositoryRoot, ['outside-link']))).rejects.toMatchObject({
      message: 'Candidate path escapes repository root: outside-link',
      name: 'RepositoryHealthPathTraversalError',
    });
  });

  test('rejects a missing repository root with the exact structured input error', async () => {
    const repositoryRoot = await createRepository();
    const missingRoot = join(repositoryRoot, 'missing');

    await expect(runRepositoryHealthCheck(input(missingRoot, []))).rejects.toBeInstanceOf(
      InvalidRepositoryHealthCheckInputError,
    );
    await expect(runRepositoryHealthCheck(input(missingRoot, []))).rejects.toMatchObject({
      message: `Repository root does not exist or is unreadable: ${missingRoot}`,
      name: 'InvalidRepositoryHealthCheckInputError',
    });
  });

  test('rejects a non-directory repository root with the exact structured input error', async () => {
    const repositoryRoot = await createRepository();
    const filePath = await createFile(repositoryRoot);

    await expect(runRepositoryHealthCheck(input(filePath, []))).rejects.toBeInstanceOf(
      InvalidRepositoryHealthCheckInputError,
    );
    await expect(runRepositoryHealthCheck(input(filePath, []))).rejects.toMatchObject({
      message: `Repository root is not a directory: ${filePath}`,
      name: 'InvalidRepositoryHealthCheckInputError',
    });
  });

  test('rejects a missing candidate path with the exact structured input error', async () => {
    const repositoryRoot = await createRepository();

    await expect(runRepositoryHealthCheck(input(repositoryRoot, ['missing.txt']))).rejects.toBeInstanceOf(
      InvalidRepositoryHealthCheckInputError,
    );
    await expect(runRepositoryHealthCheck(input(repositoryRoot, ['missing.txt']))).rejects.toMatchObject({
      message: 'Candidate path does not exist or is unreadable: missing.txt',
      name: 'InvalidRepositoryHealthCheckInputError',
    });
  });

  test('rejects invalid top-level input and malformed scan configuration with structured input errors', async () => {
    const repositoryRoot = await createRepository();
    const invalidTopLevelInput = Object.assign([], input(repositoryRoot, [])) as never;
    const malformedScanInput = {
      repositoryRoot,
      scan: Object.assign([], {
        enabledChecks: [],
        candidatePaths: [],
      }) as never,
    } as RepositoryHealthCheckInput;

    await expect(runRepositoryHealthCheck(invalidTopLevelInput)).rejects.toBeInstanceOf(
      InvalidRepositoryHealthCheckInputError,
    );
    await expect(runRepositoryHealthCheck(invalidTopLevelInput)).rejects.toMatchObject({
      message: 'Health-check input must be an object.',
      name: 'InvalidRepositoryHealthCheckInputError',
    });
    await expect(runRepositoryHealthCheck(malformedScanInput)).rejects.toBeInstanceOf(
      InvalidRepositoryHealthCheckInputError,
    );
    await expect(runRepositoryHealthCheck(malformedScanInput)).rejects.toMatchObject({
      message: 'Scan configuration must be an object.',
      name: 'InvalidRepositoryHealthCheckInputError',
    });
  });

  test('runs enabled Skill frontmatter checks with deterministic aggregation', async () => {
    const repositoryRoot = await createRepository();
    await mkdir(join(repositoryRoot, 'skills', 'custom', 'selected'), { recursive: true });
    await writeFile(join(repositoryRoot, 'skills', 'custom', 'selected', 'SKILL.md'), '---\nname: selected\ndescription: Selected\n---\n');

    await expect(runRepositoryHealthCheck({
      repositoryRoot,
      scan: { enabledChecks: ['skill-frontmatter'], candidatePaths: ['skills/custom'] },
    })).resolves.toEqual({
      healthy: true,
      findings: [],
      summary: { total: 0, errors: 0, warnings: 0 },
    });
  });
});

describe('aggregateRepositoryHealthReport', () => {
  test('sorts findings by check, path, line, and message and calculates exact counts', () => {
    const findings: readonly HealthFinding[] = [
      { checkId: 'secret', severity: 'warning', relativePath: 'z.md', line: 2, message: 'z' },
      { checkId: 'link', severity: 'error', relativePath: 'a.md', line: 2, message: 'Z' },
      { checkId: 'link', severity: 'error', relativePath: 'b.md', line: 4, message: 'b' },
      { checkId: 'link', severity: 'error', relativePath: 'a.md', line: 2, message: 'z' },
      { checkId: 'link', severity: 'error', relativePath: 'a.md', line: 2, message: 'a' },
    ];

    expect(aggregateRepositoryHealthReport(findings)).toEqual({
      healthy: false,
      findings: [
        { checkId: 'link', severity: 'error', relativePath: 'a.md', line: 2, message: 'Z' },
        { checkId: 'link', severity: 'error', relativePath: 'a.md', line: 2, message: 'a' },
        { checkId: 'link', severity: 'error', relativePath: 'a.md', line: 2, message: 'z' },
        { checkId: 'link', severity: 'error', relativePath: 'b.md', line: 4, message: 'b' },
        { checkId: 'secret', severity: 'warning', relativePath: 'z.md', line: 2, message: 'z' },
      ],
      summary: {
        total: 5,
        errors: 4,
        warnings: 1,
      },
    });
  });
});
