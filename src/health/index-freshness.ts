import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { CommandExecutionError, redactSensitiveText, runCommand } from "../adapters/command-runner.js";
import type { HealthCheckResult } from "./repository-health-check.js";
import { localMarkdownTarget, markdownDestinations } from "./markdown-targets.js";

const maxOutputBytes = 64 * 1024;
const maxDiagnosticBytes = 2_048;

type Catalog = {
  readonly indexPath: string;
  readonly targets: readonly string[];
};

function boundedDiagnostic(value: string): string {
  const redacted = redactSensitiveText(value);
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= maxDiagnosticBytes) return redacted;
  let truncated = bytes.subarray(0, maxDiagnosticBytes);
  // Decoding a partial multibyte character can expand into a replacement character.
  while (truncated.byteLength > 0) {
    const decoded = truncated.toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") <= maxDiagnosticBytes) return decoded;
    truncated = truncated.subarray(0, truncated.byteLength - 1);
  }
  return "";
}

function commandErrorObservation(error: CommandExecutionError): string {
  const output = [error.result.stdout, error.result.stderr].filter((part) => part.length > 0).join("\n");
  return output.length > 0 ? boundedDiagnostic(output) : "Command execution failed without diagnostics";
}

function catalogsFromTrackedPaths(trackedPaths: readonly string[]): readonly Catalog[] {
  const skillTargets = trackedPaths.filter((path) =>
    /^skills\/custom\/[^/]+\/SKILL\.md$/u.test(path)
    || /^\.agents\/skills\/[^/]+\/SKILL\.md$/u.test(path)
    || (/^skills\/external\/[^/]+\.md$/u.test(path) && path !== "skills/external/README.md"));

  const knowledgeTargets = new Set<string>();
  const projectTargets = new Set<string>();
  for (const path of trackedPaths) {
    const knowledgeMatch = /^knowledge\/([^/]+)\/.+/u.exec(path);
    if (knowledgeMatch?.[1] !== undefined) knowledgeTargets.add(`knowledge/${knowledgeMatch[1]}`);
    const projectMatch = /^projects\/([^/]+)\/STATUS\.md$/u.exec(path);
    if (projectMatch?.[1] !== undefined && projectMatch[1] !== "_template") {
      projectTargets.add(`projects/${projectMatch[1]}`);
    }
  }

  return [
    { indexPath: "indexes/SKILLS.md", targets: skillTargets },
    { indexPath: "indexes/KNOWLEDGE.md", targets: [...knowledgeTargets] },
    { indexPath: "indexes/PROJECTS.md", targets: [...projectTargets] },
  ];
}

function normalizedIndexTargets(workspacePath: string, indexPath: string, markdown: string): readonly string[] {
  const sourcePath = resolve(workspacePath, indexPath);
  return markdownDestinations(markdown)
    .map(localMarkdownTarget)
    .filter((target): target is string => target !== null)
    .map((target) => relative(workspacePath, resolve(sourcePath, "..", target)).split(sep).join("/"));
}

export async function validateIndexFreshness(workspacePath: string, timeoutMs: number): Promise<HealthCheckResult> {
  let trackedPaths: readonly string[];
  try {
    const result = await runCommand({
      command: "git",
      arguments: ["ls-files", "-z"],
      cwd: workspacePath,
      timeoutMs,
      maxOutputBytes,
    });
    trackedPaths = result.stdout.split("\0").filter((path) => path.length > 0);
  } catch (error: unknown) {
    return {
      id: "index-freshness",
      status: "blocked",
      observation: error instanceof CommandExecutionError ? commandErrorObservation(error) : boundedDiagnostic(String(error)),
    };
  }

  const findings: string[] = [];
  try {
    for (const catalog of catalogsFromTrackedPaths(trackedPaths)) {
      const markdown = await readFile(resolve(workspacePath, catalog.indexPath), "utf8");
      const indexedTargets = normalizedIndexTargets(workspacePath, catalog.indexPath, markdown);
      for (const target of catalog.targets) {
        const occurrences = indexedTargets.filter((indexedTarget) => indexedTarget === target).length;
        if (occurrences !== 1) findings.push(`${catalog.indexPath}: ${target} (${occurrences} links)`);
      }
    }
  } catch (error: unknown) {
    return { id: "index-freshness", status: "blocked", observation: boundedDiagnostic(String(error)) };
  }

  findings.sort();
  return findings.length === 0
    ? { id: "index-freshness", status: "passed", observation: "All required catalog targets are indexed exactly once" }
    : { id: "index-freshness", status: "failed", observation: `Index freshness findings: ${findings.join(", ")}` };
}
