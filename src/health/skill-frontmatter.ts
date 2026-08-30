import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { redactSensitiveText, runCommand } from "../adapters/command-runner.js";
import type { HealthCheckResult } from "./repository-health-check.js";

const maxOutputBytes = 64 * 1024;
const maxDiagnosticBytes = 2_048;
const skillPathPattern = /^(?:skills\/custom|\.agents\/skills)\/[^/]+\/SKILL\.md$/u;

type Finding = {
  readonly path: string;
  readonly reason: string;
};

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const pathRelative = relative(rootPath, candidatePath);
  return pathRelative === ""
    || (pathRelative !== ".." && !pathRelative.startsWith(`..${sep}`) && !isAbsolute(pathRelative));
}

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

function boundedObservation(value: string): string {
  return truncateUtf8(redactSensitiveText(value), maxDiagnosticBytes);
}

function pathForObservation(path: string): string {
  return redactSensitiveText(path.replaceAll("\\", "/"));
}

function findingsObservation(findings: readonly Finding[]): string {
  const sorted = [...findings].sort((left, right) => {
    const pathOrder = left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
    if (pathOrder !== 0) return pathOrder;
    return left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0;
  });
  return boundedObservation(sorted.map((finding) => `${pathForObservation(finding.path)}: ${finding.reason}`).join(", "));
}

function extractFrontmatter(contents: string): string | null {
  const withoutBom = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  const lines = withoutBom.split(/\r?\n/u);
  if (lines[0] !== "---") return null;
  const closingMarker = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingMarker < 0) return null;
  return lines.slice(1, closingMarker).join("\n");
}

function validateFrontmatter(contents: string): string | null {
  const frontmatter = extractFrontmatter(contents);
  if (frontmatter === null) return "invalid YAML frontmatter";

  let parsed: unknown;
  try {
    const document = parseDocument(frontmatter, { logLevel: "silent" });
    if (document.errors.length > 0) return "invalid YAML frontmatter";
    parsed = document.toJS() as unknown;
  } catch {
    return "invalid YAML frontmatter";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "frontmatter must be a mapping";
  }

  const metadata = parsed as Record<string, unknown>;
  if (typeof metadata.name !== "string" || metadata.name.trim().length === 0) {
    return "name must be a non-empty string";
  }
  if (typeof metadata.description !== "string" || metadata.description.trim().length === 0) {
    return "description must be a non-empty string";
  }
  return null;
}

export async function validateSkillFrontmatter(workspacePath: string, timeoutMs: number): Promise<HealthCheckResult> {
  let trackedPaths: readonly string[];
  try {
    const result = await runCommand({
      command: "git",
      arguments: ["ls-files", "-z", "--", "skills/custom/*/SKILL.md", ".agents/skills/*/SKILL.md"],
      cwd: workspacePath,
      timeoutMs,
      maxOutputBytes,
    });
    trackedPaths = result.stdout.split("\0").filter((path) => skillPathPattern.test(path));
  } catch {
    return {
      id: "skill-frontmatter",
      status: "blocked",
      observation: "Unable to enumerate tracked Skill frontmatter files",
    };
  }

  let resolvedWorkspacePath: string;
  try {
    resolvedWorkspacePath = await realpath(workspacePath);
  } catch {
    return {
      id: "skill-frontmatter",
      status: "blocked",
      observation: "Unable to resolve the repository workspace for Skill frontmatter inspection",
    };
  }

  const failures: Finding[] = [];
  const blocked: Finding[] = [];
  for (const trackedPath of trackedPaths) {
    const candidatePath = resolve(workspacePath, trackedPath);
    let resolvedSkillPath: string;
    try {
      resolvedSkillPath = await realpath(candidatePath);
    } catch {
      blocked.push({ path: trackedPath, reason: "unable to read tracked Skill frontmatter" });
      continue;
    }
    if (!isWithinRoot(resolvedWorkspacePath, resolvedSkillPath)) {
      blocked.push({ path: trackedPath, reason: "tracked Skill path resolves outside the repository" });
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(resolvedSkillPath, "utf8");
    } catch {
      blocked.push({ path: trackedPath, reason: "unable to read tracked Skill frontmatter" });
      continue;
    }
    const reason = validateFrontmatter(contents);
    if (reason !== null) failures.push({ path: trackedPath, reason });
  }

  if (blocked.length > 0) {
    return {
      id: "skill-frontmatter",
      status: "blocked",
      observation: findingsObservation(blocked),
    };
  }
  if (failures.length > 0) {
    return {
      id: "skill-frontmatter",
      status: "failed",
      observation: findingsObservation(failures),
    };
  }
  return {
    id: "skill-frontmatter",
    status: "passed",
    observation: "All tracked Skill frontmatter is valid",
  };
}
