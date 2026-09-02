import { open, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CommandExecutionError, redactSensitiveText, runCommand } from "../adapters/command-runner.js";
import { canonicalPath } from "../domain/canonical-path.js";
import { validateIndexFreshness } from "./index-freshness.js";
import { localMarkdownTarget, markdownDestinations } from "./markdown-targets.js";
import { validateSkillFrontmatter } from "./skill-frontmatter.js";

export type HealthStatus = "healthy" | "unhealthy" | "blocked";
export type HealthCheckStatus = "passed" | "failed" | "blocked" | "skipped";

export interface HealthCheckResult {
  readonly id: string;
  readonly status: HealthCheckStatus;
  readonly observation: string;
}

export interface RepositoryHealthReport {
  readonly status: HealthStatus;
  readonly workspacePath: string;
  readonly checks: readonly HealthCheckResult[];
}

const requiredFiles = [
  "AGENTS.md",
  "README.md",
  "indexes/SKILLS.md",
  "indexes/KNOWLEDGE.md",
  "indexes/PROJECTS.md",
  "projects/d-ai-hub/STATUS.md",
] as const;

// Keep command capture finite while accommodating ordinary repository test logs.
const maxOutputBytes = 64 * 1024;
const maxDiagnosticBytes = 2_048;
const defaultTimeoutMs = 300_000;

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let truncated = bytes.subarray(0, maxBytes);
  while (truncated.byteLength > 0) {
    const decoded = truncated.toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") <= maxBytes) return decoded;
    truncated = truncated.subarray(0, truncated.byteLength - 1);
  }
  return "";
}

function boundedDiagnostic(value: string): string {
  return truncateUtf8(redactSensitiveText(value), maxDiagnosticBytes);
}

function commandErrorObservation(error: CommandExecutionError): string {
  const output = [error.result.stdout, error.result.stderr].filter((part) => part.length > 0).join("\n");
  const diagnostic = boundedDiagnostic(output);
  return diagnostic.length > 0 ? diagnostic : "Command execution failed without diagnostics";
}

function pathsMatch(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function overallStatus(checks: readonly HealthCheckResult[]): HealthStatus {
  if (checks.some((check) => check.status === "blocked")) return "blocked";
  if (checks.some((check) => check.status === "failed")) return "unhealthy";
  return "healthy";
}

async function isReadableFile(filePath: string): Promise<boolean> {
  const details = await stat(filePath);
  if (!details.isFile()) return false;
  const handle = await open(filePath, "r");
  await handle.close();
  return true;
}

function isWithinRepository(workspacePath: string, candidatePath: string): boolean {
  const relativePath = relative(workspacePath, candidatePath);
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function relativeDisplayPath(workspacePath: string, filePath: string): string {
  const displayPath = relative(workspacePath, filePath).split(sep).join("/");
  return redactSensitiveText(displayPath.length === 0 ? "." : displayPath);
}

async function validateTrackedMarkdownLinks(workspacePath: string, timeoutMs: number): Promise<HealthCheckResult> {
  let trackedFiles: readonly string[];
  try {
    const result = await runCommand({
      command: "git",
      arguments: ["ls-files", "-z", "--", "*.md"],
      cwd: workspacePath,
      timeoutMs,
      maxOutputBytes,
    });
    trackedFiles = result.stdout.split("\0").filter((filePath) => filePath.length > 0);
  } catch (error: unknown) {
    return {
      id: "markdown-links",
      status: "blocked",
      observation: error instanceof CommandExecutionError ? commandErrorObservation(error) : boundedDiagnostic(String(error)),
    };
  }

  const failures: string[] = [];
  for (const trackedFile of trackedFiles) {
    const sourcePath = resolve(workspacePath, trackedFile);
    if (!isWithinRepository(workspacePath, sourcePath) || trackedFile.split(/[\\/]/u).includes(".git")) continue;
    let resolvedSourcePath: string;
    try {
      resolvedSourcePath = await realpath(sourcePath);
    } catch {
      failures.push(`${relativeDisplayPath(workspacePath, sourcePath)} -> ${relativeDisplayPath(workspacePath, sourcePath)}`);
      continue;
    }
    if (!isWithinRepository(workspacePath, resolvedSourcePath)) {
      failures.push(`${relativeDisplayPath(workspacePath, sourcePath)} -> ${relativeDisplayPath(workspacePath, resolvedSourcePath)}`);
      continue;
    }
    let markdown: string;
    try {
      markdown = await readFile(sourcePath, "utf8");
    } catch {
      failures.push(`${relativeDisplayPath(workspacePath, sourcePath)} -> ${redactSensitiveText(trackedFile)}`);
      continue;
    }
    for (const destination of markdownDestinations(markdown)) {
      const localTarget = localMarkdownTarget(destination);
      if (localTarget === null) continue;
      const targetPath = resolve(sourcePath, "..", localTarget);
      if (!isWithinRepository(workspacePath, targetPath)) {
        failures.push(`${relativeDisplayPath(workspacePath, sourcePath)} -> ${relativeDisplayPath(workspacePath, targetPath)}`);
        continue;
      }
      try {
        await stat(targetPath);
        const resolvedTargetPath = await realpath(targetPath);
        if (!isWithinRepository(workspacePath, resolvedTargetPath)) {
          failures.push(`${relativeDisplayPath(workspacePath, sourcePath)} -> ${relativeDisplayPath(workspacePath, targetPath)}`);
        }
      } catch {
        failures.push(`${relativeDisplayPath(workspacePath, sourcePath)} -> ${relativeDisplayPath(workspacePath, targetPath)}`);
      }
    }
  }
  return failures.length === 0
    ? { id: "markdown-links", status: "passed", observation: "All tracked Markdown links resolve within the repository" }
    : { id: "markdown-links", status: "failed", observation: `Broken tracked Markdown links: ${failures.join(", ")}` };
}

async function runWorkingTreeCheck(
  workspacePath: string,
  timeoutMs: number,
  id: "working-tree" | "working-tree-final",
): Promise<HealthCheckResult> {
  try {
    const result = await runCommand({
      command: "git",
      arguments: ["status", "--porcelain=v1", "--untracked-files=all"],
      cwd: workspacePath,
      timeoutMs,
      maxOutputBytes,
    });
    const workingTree = result.stdout.trim();
    return workingTree.length === 0
      ? { id, status: "passed", observation: "Working tree is clean" }
      : { id, status: "failed", observation: `Working tree has changes:\n${boundedDiagnostic(workingTree)}` };
  } catch (error: unknown) {
    return {
      id,
      status: "blocked",
      observation: error instanceof CommandExecutionError ? commandErrorObservation(error) : boundedDiagnostic(String(error)),
    };
  }
}

async function runPackageManagerCheck(
  workspacePath: string,
  timeoutMs: number,
  script: "typecheck" | "test" | "test:integration",
): Promise<HealthCheckResult> {
  try {
    const isWindows = process.platform === "win32";
    await runCommand({
      command: isWindows ? (process.env.ComSpec ?? "cmd.exe") : "npm",
      arguments: isWindows ? ["/d", "/s", "/c", "npm.cmd", "run", script] : ["run", script],
      cwd: workspacePath,
      timeoutMs,
      maxOutputBytes,
    });
    return { id: script, status: "passed", observation: `npm run ${script} completed successfully` };
  } catch (error: unknown) {
    return {
      id: script,
      status: "failed",
      observation: error instanceof CommandExecutionError ? commandErrorObservation(error) : boundedDiagnostic(String(error)),
    };
  }
}

export async function runRepositoryHealthCheck(input: {
  readonly workspacePath: string;
  readonly timeoutMs?: number;
  readonly structuralOnly?: boolean;
}): Promise<RepositoryHealthReport> {
  if (input.workspacePath.trim().length === 0) {
    return {
      status: "blocked",
      workspacePath: input.workspacePath,
      checks: [{ id: "repository-identity", status: "blocked", observation: "Workspace path must be non-empty" }],
    };
  }
  const workspacePath = await canonicalPath(input.workspacePath);
  const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
  const checks: HealthCheckResult[] = [];
  let repositoryIdentityPassed = false;

  try {
    const result = await runCommand({
      command: "git",
      arguments: ["rev-parse", "--show-toplevel"],
      cwd: workspacePath,
      timeoutMs,
      maxOutputBytes,
    });
    const reportedRoot = resolve(result.stdout.trim());
    if (!pathsMatch(reportedRoot, workspacePath)) {
      checks.push({
        id: "repository-identity",
        status: "blocked",
        observation: boundedDiagnostic(`Git root ${reportedRoot} does not match workspace ${workspacePath}`),
      });
    } else {
      repositoryIdentityPassed = true;
      checks.push({ id: "repository-identity", status: "passed", observation: "Git repository identity matches the workspace path" });
    }
  } catch (error: unknown) {
    if (error instanceof CommandExecutionError) {
      checks.push({ id: "repository-identity", status: "blocked", observation: commandErrorObservation(error) });
    } else {
      checks.push({ id: "repository-identity", status: "blocked", observation: boundedDiagnostic(String(error)) });
    }
  }

  if (!repositoryIdentityPassed) return { status: "blocked", workspacePath, checks };

  checks.push(await runWorkingTreeCheck(workspacePath, timeoutMs, "working-tree"));

  const missingFiles: string[] = [];
  for (const relativePath of requiredFiles) {
    try {
      if (!(await isReadableFile(resolve(workspacePath, relativePath)))) missingFiles.push(relativePath);
    } catch {
      missingFiles.push(relativePath);
    }
  }
  const requiredFilesCheck: HealthCheckResult = missingFiles.length === 0
    ? { id: "required-files", status: "passed", observation: "All required repository files are readable" }
    : { id: "required-files", status: "blocked", observation: `Missing or unreadable required files: ${missingFiles.join(", ")}` };
  checks.push(requiredFilesCheck);
  if (requiredFilesCheck.status === "blocked") return { status: overallStatus(checks), workspacePath, checks };

  checks.push(await validateIndexFreshness(workspacePath, timeoutMs));
  checks.push(await validateSkillFrontmatter(workspacePath, timeoutMs));
  checks.push(await validateTrackedMarkdownLinks(workspacePath, timeoutMs));
  if (input.structuralOnly !== true) {
    checks.push(
      await runPackageManagerCheck(workspacePath, timeoutMs, "typecheck"),
      await runPackageManagerCheck(workspacePath, timeoutMs, "test"),
      await runPackageManagerCheck(workspacePath, timeoutMs, "test:integration"),
    );
  }
  checks.push(await runWorkingTreeCheck(workspacePath, timeoutMs, "working-tree-final"));

  return { status: overallStatus(checks), workspacePath, checks };
}
