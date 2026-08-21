import { open, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { HealthCheckId, HealthFinding } from "./types.js";
import { isPlatformPathWithinRoot } from "./path-safety.js";
import { redactHealthFindings } from "./redaction.js";
import { collectRepositoryFiles, readFatalUtf8File } from "./repository-files.js";

interface MarkdownDocument {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly content: string;
}

interface MarkdownLink {
  readonly target: string;
  readonly line: number;
}

const markdownLinkPattern = /\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g;

function compareStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function toRelativePath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function isWithin(repositoryRoot: string, candidatePath: string): boolean {
  return isPlatformPathWithinRoot(repositoryRoot, candidatePath);
}

function isExternalTarget(target: string): boolean {
  return target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(target);
}

function stripFragment(target: string): string {
  const fragmentIndex = target.indexOf("#");
  return fragmentIndex === -1 ? target : target.slice(0, fragmentIndex);
}

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function extractLinks(content: string): readonly MarkdownLink[] {
  const links: MarkdownLink[] = [];
  for (const match of content.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1];
    if (rawTarget === undefined) continue;
    const target = rawTarget.startsWith("<") && rawTarget.endsWith(">") ? rawTarget.slice(1, -1) : rawTarget;
    links.push({ target, line: lineNumber(content, match.index) });
  }
  return links;
}

async function collectMarkdownDocuments(repositoryRoot: string, candidatePaths: readonly string[]): Promise<readonly MarkdownDocument[]> {
  const files = await collectRepositoryFiles(repositoryRoot, candidatePaths);
  const documents = await Promise.all(files
    .filter((file) => file.relativePath.toLowerCase().endsWith(".md"))
    .map(async (file): Promise<MarkdownDocument> => ({
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      content: await readFatalUtf8File(repositoryRoot, file.absolutePath),
    })));
  return documents.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

async function validateTarget(repositoryRoot: string, sourcePath: string, rawTarget: string): Promise<string | null> {
  const target = stripFragment(rawTarget);
  if (target.length === 0 || isExternalTarget(rawTarget)) return null;
  const decodedTarget = target.replace(/\\/g, "/");
  const targetPath = resolve(sourcePath, "..", decodedTarget);
  if (!isWithin(repositoryRoot, targetPath)) return "unsafe";

  let canonicalTarget: string;
  try {
    canonicalTarget = await realpath(targetPath);
  } catch (error) {
    if (error instanceof Error && isMissingPathError(error)) return "missing";
    return "unreadable";
  }
  if (!isWithin(repositoryRoot, canonicalTarget)) return "unsafe";
  try {
    const targetStatus = await stat(canonicalTarget);
    if (targetStatus.isFile()) {
      const handle = await open(canonicalTarget, "r");
      await handle.close();
    }
  } catch {
    return "unreadable";
  }
  return null;
}

function isMissingPathError(error: Error): boolean {
  return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT";
}

export async function scanMarkdownLinks(repositoryRoot: string, candidatePaths: readonly string[]): Promise<readonly HealthFinding[]> {
  return scanMarkdownDocumentsForCheck(repositoryRoot, candidatePaths, "link", "Markdown link target");
}

export async function scanMarkdownDocumentsForCheck(
  repositoryRoot: string,
  candidatePaths: readonly string[],
  checkId: HealthCheckId,
  targetLabel: string,
): Promise<readonly HealthFinding[]> {
  const documents = await collectMarkdownDocuments(repositoryRoot, candidatePaths);
  const findings: HealthFinding[] = [];
  for (const document of documents) {
    for (const link of extractLinks(document.content)) {
      const result = await validateTarget(repositoryRoot, document.absolutePath, link.target);
      if (result === null) continue;
      const message = result === "missing"
        ? `Missing local ${targetLabel}: ${link.target}`
        : result === "unsafe"
          ? `Unsafe local ${targetLabel}: ${link.target}`
          : `Unreadable local ${targetLabel}: ${link.target}`;
      findings.push({ checkId, severity: "error", relativePath: document.relativePath, line: link.line, message });
    }
  }
  return redactHealthFindings(findings);
}

export { collectMarkdownDocuments, extractLinks, isWithin, stripFragment, toRelativePath, validateTarget };
