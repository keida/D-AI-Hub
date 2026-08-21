import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  HealthCheckId,
  HealthFinding,
  RepositoryHealthCheckInput,
  RepositoryHealthReport,
} from "./types.js";
import { scanIndexFreshness, selectIndexCandidatePaths } from "./index-freshness.js";
import { scanMarkdownLinks } from "./markdown-links.js";
import { scanSecrets } from "./secret-scan.js";
import { scanSkillFrontmatter } from "./skill-frontmatter.js";
import {
  InvalidRepositoryHealthCheckInputError,
  RepositoryHealthPathTraversalError,
} from "./errors.js";
import { isPlatformPathWithinRoot } from "./path-safety.js";
import { redactHealthFindings } from "./redaction.js";

export {
  InvalidRepositoryHealthCheckInputError,
  RepositoryHealthPathTraversalError,
  RepositoryHealthTextDecodingError,
} from "./errors.js";

const healthCheckIds: ReadonlySet<HealthCheckId> = new Set<HealthCheckId>([
  "index",
  "link",
  "secret",
  "skill-frontmatter",
]);

function compareFindings(left: HealthFinding, right: HealthFinding): number {
  const checkComparison = compareCodeUnits(left.checkId, right.checkId);
  if (checkComparison !== 0) return checkComparison;

  const pathComparison = compareCodeUnits(left.relativePath, right.relativePath);
  if (pathComparison !== 0) return pathComparison;

  const leftLine = left.line ?? Number.POSITIVE_INFINITY;
  const rightLine = right.line ?? Number.POSITIVE_INFINITY;
  if (leftLine !== rightLine) return leftLine - rightLine;

  return compareCodeUnits(left.message, right.message);
}

function compareCodeUnits(left: string, right: string): number {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function aggregateRepositoryHealthReport(findings: readonly HealthFinding[]): RepositoryHealthReport {
  const sortedFindings = [...redactHealthFindings(findings)].sort(compareFindings);
  const errors = sortedFindings.filter((finding) => finding.severity === "error").length;
  const warnings = sortedFindings.filter((finding) => finding.severity === "warning").length;

  return {
    healthy: sortedFindings.length === 0,
    findings: sortedFindings,
    summary: {
      total: sortedFindings.length,
      errors,
      warnings,
    },
  };
}

function assertRepositoryRoot(repositoryRoot: string): string {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim().length === 0) {
    throw new InvalidRepositoryHealthCheckInputError("Repository root must be a non-empty absolute path.");
  }
  if (!isAbsolute(repositoryRoot)) {
    throw new InvalidRepositoryHealthCheckInputError(`Repository root must be absolute: ${repositoryRoot}`);
  }
  return resolve(repositoryRoot);
}

async function resolveRepositoryDirectory(repositoryRoot: string): Promise<string> {
  try {
    const status = await stat(repositoryRoot);
    if (!status.isDirectory()) {
      throw new InvalidRepositoryHealthCheckInputError(`Repository root is not a directory: ${repositoryRoot}`);
    }
    return await realpath(repositoryRoot);
  } catch (error) {
    if (error instanceof InvalidRepositoryHealthCheckInputError) throw error;
    throw new InvalidRepositoryHealthCheckInputError(`Repository root does not exist or is unreadable: ${repositoryRoot}`);
  }
}

function assertScanConfiguration(input: RepositoryHealthCheckInput): void {
  if (input.scan === null || typeof input.scan !== "object" || !isPlainObject(input.scan)) {
    throw new InvalidRepositoryHealthCheckInputError("Scan configuration must be an object.");
  }
  if (!Array.isArray(input.scan.enabledChecks) || !Array.isArray(input.scan.candidatePaths)) {
    throw new InvalidRepositoryHealthCheckInputError("Scan configuration must declare enabledChecks and candidatePaths arrays.");
  }

  const uniqueChecks = new Set<HealthCheckId>();
  for (const checkId of input.scan.enabledChecks) {
    if (typeof checkId !== "string" || !healthCheckIds.has(checkId as HealthCheckId)) {
      throw new InvalidRepositoryHealthCheckInputError(`Unknown health check identifier: ${String(checkId)}`);
    }
    const normalizedCheckId = checkId as HealthCheckId;
    if (uniqueChecks.has(normalizedCheckId)) {
      throw new InvalidRepositoryHealthCheckInputError(`Duplicate health check identifier: ${checkId}`);
    }
    uniqueChecks.add(normalizedCheckId);
  }
}

function isPlainObject(value: object): boolean {
  return Object.getPrototypeOf(value) === Object.prototype;
}

function isMissingPathError(error: Error): boolean {
  return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT";
}

async function assertCandidatePaths(repositoryRoot: string, candidatePaths: readonly string[]): Promise<void> {
  for (const candidatePath of candidatePaths) {
    if (typeof candidatePath !== "string" || candidatePath.trim().length === 0) {
      throw new InvalidRepositoryHealthCheckInputError("Candidate paths must be non-empty strings.");
    }
    const resolvedCandidate = resolve(repositoryRoot, candidatePath);
    if (!isPlatformPathWithinRoot(repositoryRoot, resolvedCandidate)) {
      throw new RepositoryHealthPathTraversalError(`Candidate path escapes repository root: ${candidatePath}`);
    }
    try {
      const canonicalCandidate = await realpath(resolvedCandidate);
      if (!isPlatformPathWithinRoot(repositoryRoot, canonicalCandidate)) {
        throw new RepositoryHealthPathTraversalError(`Candidate path escapes repository root: ${candidatePath}`);
      }
    } catch (error) {
      if (error instanceof RepositoryHealthPathTraversalError) throw error;
      if (error instanceof Error && isMissingPathError(error)) {
        throw new InvalidRepositoryHealthCheckInputError(`Candidate path does not exist or is unreadable: ${candidatePath}`);
      }
      throw new InvalidRepositoryHealthCheckInputError(`Candidate path is unreadable: ${candidatePath}`);
    }
  }
}

export async function runRepositoryHealthCheck(input: RepositoryHealthCheckInput): Promise<RepositoryHealthReport> {
  if (input === null || typeof input !== "object" || !isPlainObject(input)) {
    throw new InvalidRepositoryHealthCheckInputError("Health-check input must be an object.");
  }
  const repositoryRoot = assertRepositoryRoot(input.repositoryRoot);
  assertScanConfiguration(input);
  const canonicalRepositoryRoot = await resolveRepositoryDirectory(repositoryRoot);
  await assertCandidatePaths(canonicalRepositoryRoot, input.scan.candidatePaths);

  const findings: HealthFinding[] = [];
  if (input.scan.enabledChecks.includes("link")) {
    findings.push(...await scanMarkdownLinks(canonicalRepositoryRoot, input.scan.candidatePaths));
  }
  if (input.scan.enabledChecks.includes("index")) {
    const indexCandidatePaths = await selectIndexCandidatePaths(canonicalRepositoryRoot, input.scan.candidatePaths);
    findings.push(...await scanIndexFreshness(canonicalRepositoryRoot, indexCandidatePaths));
  }
  if (input.scan.enabledChecks.includes("skill-frontmatter")) {
    findings.push(...await scanSkillFrontmatter(canonicalRepositoryRoot, input.scan.candidatePaths));
  }
  if (input.scan.enabledChecks.includes("secret")) {
    findings.push(...await scanSecrets(canonicalRepositoryRoot, input.scan.candidatePaths));
  }
  return aggregateRepositoryHealthReport(findings);
}
