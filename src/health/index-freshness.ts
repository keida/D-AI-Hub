import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { CommandExecutionError, redactSensitiveText, runCommand } from "../adapters/command-runner.js";
import type { HealthCheckResult } from "./repository-health-check.js";
import { localMarkdownTarget, markdownDestinations } from "./markdown-targets.js";

const maxOutputBytes = 64 * 1024;
const maxDiagnosticBytes = 2_048;
const maxProjectStatusBytes = 64 * 1024;

type Catalog = {
  readonly indexPath: string;
  readonly targets: readonly string[];
};

type ProjectSection = "active" | "planned" | "archived";
type CurrentPullRequestState = "open" | "draft" | "merged" | "closed";

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

function projectSections(workspacePath: string, markdown: string): ReadonlyMap<string, readonly ProjectSection[]> {
  const sections = new Map<string, ProjectSection[]>();
  let currentSection: ProjectSection | null = null;
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^##\s+(Active|Planned|Archived) projects\s*$/iu.exec(line);
    if (heading?.[1] !== undefined) currentSection = heading[1].toLowerCase() as ProjectSection;
    else if (/^##\s+/u.test(line)) currentSection = null;
    if (currentSection === null) continue;
    for (const destination of markdownDestinations(line)) {
      const target = localMarkdownTarget(destination);
      if (target === null) continue;
      const normalized = relative(workspacePath, resolve(workspacePath, "indexes", target)).split(sep).join("/");
      if (!normalized.startsWith("projects/")) continue;
      const existing = sections.get(normalized) ?? [];
      existing.push(currentSection);
      sections.set(normalized, existing);
    }
  }
  return sections;
}

function expectedProjectSection(lifecycle: string): ProjectSection | null {
  if (["active", "blocked", "paused"].includes(lifecycle)) return "active";
  if (lifecycle === "planned") return "planned";
  if (["archived", "completed", "superseded"].includes(lifecycle)) return "archived";
  return null;
}

function oneField(markdown: string, label: string): string | null {
  const matches = [...markdown.matchAll(new RegExp(`^- ${label}: (.+)$`, "gmu"))];
  return matches.length === 1 ? matches[0]?.[1]?.trim() ?? null : null;
}

function currentPullRequestState(value: string): CurrentPullRequestState | null {
  const match = /^#[1-9][0-9]* \((open|draft|merged|closed)\)$/u.exec(value);
  return match?.[1] as CurrentPullRequestState | undefined ?? null;
}

function legacyPullRequestFindings(project: string, lifecycle: string | null, currentPr: string | null, required: boolean): readonly string[] {
  if (currentPr === null) return required ? [`${project}/STATUS.md: invalid Current PR`] : [];
  if (currentPr === "none") return [];
  const prState = currentPullRequestState(currentPr);
  if (prState === null) return [`${project}/STATUS.md: invalid Current PR`];
  if (["active", "blocked", "paused"].includes(lifecycle ?? "") && ["merged", "closed"].includes(prState)) {
    return [`${project}/STATUS.md: Current PR state ${prState} conflicts with lifecycle ${lifecycle}`];
  }
  if (lifecycle === "planned" || (["archived", "completed", "superseded"].includes(lifecycle ?? "") && ["open", "draft"].includes(prState))) {
    return [`${project}/STATUS.md: Current PR state ${prState} conflicts with lifecycle ${lifecycle}`];
  }
  return [];
}

function hasExactlyOneLivePrStatusBoundary(status: string): boolean {
  const phraseOccurrences = [...status.matchAll(/Live PR status must be queried from GitHub/giu)];
  const canonicalLines = [...status.matchAll(/^- Live PR status must be queried from GitHub\.\r?$/gmu)];
  return phraseOccurrences.length === 1 && canonicalLines.length === 1;
}

function isWithinWorkspace(workspacePath: string, candidatePath: string): boolean {
  const relativePath = relative(workspacePath, candidatePath);
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

async function projectStateFindings(
  workspacePath: string,
  projects: readonly string[],
  indexMarkdown: string,
): Promise<readonly string[]> {
  const findings: string[] = [];
  const sections = projectSections(workspacePath, indexMarkdown);
  for (const project of projects) {
    const statusPath = resolve(workspacePath, project, "STATUS.md");
    const resolvedStatusPath = await realpath(statusPath);
    if (!isWithinWorkspace(workspacePath, resolvedStatusPath)) throw new Error(`${project}/STATUS.md resolves outside the repository`);
    const details = await stat(resolvedStatusPath);
    if (!details.isFile() || details.size > maxProjectStatusBytes) throw new Error(`${project}/STATUS.md is not a bounded readable file`);
    const status = await readFile(resolvedStatusPath, "utf8");
    const lifecycle = oneField(status, "Lifecycle");
    const expected = lifecycle === null ? null : expectedProjectSection(lifecycle);
    const indexedSections = sections.get(project) ?? [];
    if (expected === null) findings.push(`${project}/STATUS.md: missing or unsupported Lifecycle`);
    else if (indexedSections.length !== 1 || indexedSections[0] !== expected) {
      findings.push(`${project}: lifecycle ${lifecycle} is not indexed under ${expected} projects`);
    }

    const lastMergedDelivery = oneField(status, "Last merged delivery");
    const activeProposal = oneField(status, "Active proposal");
    const currentPr = oneField(status, "Current PR");
    if (lastMergedDelivery === null && activeProposal === null) {
      findings.push(...legacyPullRequestFindings(project, lifecycle, currentPr, true));
    } else {
      if (lastMergedDelivery === null || !/^PR #[1-9][0-9]*$/u.test(lastMergedDelivery)) {
        findings.push(`${project}/STATUS.md: invalid Last merged delivery`);
      }
      if (activeProposal === null || !/^(?:none|PR #[1-9][0-9]*)$/u.test(activeProposal)) {
        findings.push(`${project}/STATUS.md: invalid Active proposal`);
      }
      if (!hasExactlyOneLivePrStatusBoundary(status)) {
        findings.push(`${project}/STATUS.md: missing live PR status boundary`);
      }
      if (/^- Current PR:/mu.test(status)) {
        findings.push(`${project}/STATUS.md: stable PR fields cannot coexist with Current PR`);
      }
    }
  }

  const continuation = /^## Continuation rule\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/imu.exec(indexMarkdown)?.[1] ?? "";
  const hasCanonicalProjectMemoryLink = markdownDestinations(continuation).some((destination) => {
    const target = localMarkdownTarget(destination);
    if (target === null) return false;
    return relative(workspacePath, resolve(workspacePath, "indexes", target)).split(sep).join("/")
      === "skills/custom/project-memory/SKILL.md";
  });
  const completeRule = /complete project set only for([^\n.]*)/iu.exec(continuation)?.[1] ?? "";
  const completeRuleWords = completeRule.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/gu) ?? [];
  const allowedCompleteRuleWords = new Set([
    "close", "audit", "conflict", "or", "and", "an", "explicit", "complete-context", "request",
  ]);
  const hasBoundedCompleteRule = completeRuleWords.some((word) => ["close", "audit", "conflict", "explicit"].includes(word))
    && completeRuleWords.every((word) => allowedCompleteRuleWords.has(word));
  if (!hasCanonicalProjectMemoryLink
    || !/read\s+`?STATUS\.md`?\s+first/iu.test(continuation)
    || !hasBoundedCompleteRule) {
    findings.push("indexes/PROJECTS.md: continuation rule does not delegate progressive loading to project-memory");
  }
  return findings;
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
    const catalogs = catalogsFromTrackedPaths(trackedPaths);
    for (const catalog of catalogs) {
      const markdown = await readFile(resolve(workspacePath, catalog.indexPath), "utf8");
      const indexedTargets = normalizedIndexTargets(workspacePath, catalog.indexPath, markdown);
      for (const target of catalog.targets) {
        const occurrences = indexedTargets.filter((indexedTarget) => indexedTarget === target).length;
        if (occurrences !== 1) findings.push(`${catalog.indexPath}: ${target} (${occurrences} links)`);
      }
      if (catalog.indexPath === "indexes/PROJECTS.md") {
        findings.push(...await projectStateFindings(workspacePath, catalog.targets, markdown));
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
