import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { HealthFinding } from "./types.js";
import { collectMarkdownDocuments, extractLinks, isWithin, stripFragment, validateTarget } from "./markdown-links.js";
import { redactHealthFindings } from "./redaction.js";

const canonicalIndexPaths = ["indexes/SKILLS.md", "indexes/KNOWLEDGE.md", "indexes/PROJECTS.md"] as const;
const canonicalIndexPathSet = new Set<string>(canonicalIndexPaths);

function isExternalTarget(target: string): boolean {
  return target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/iu.test(target);
}

export function normalizeIndexTargetPath(documentPath: string, target: string): string {
  return resolve(dirname(documentPath), target.replace(/\\/g, "/"));
}

function isMissingPathError(error: Error): boolean {
  return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT";
}

async function resolvePresentCanonicalIndexPath(repositoryRoot: string, relativePath: string): Promise<string | null> {
  try {
    return await realpath(resolve(repositoryRoot, relativePath));
  } catch (error) {
    if (error instanceof Error && isMissingPathError(error)) return null;
    throw error;
  }
}

export async function selectIndexCandidatePaths(
  repositoryRoot: string,
  candidatePaths: readonly string[],
): Promise<readonly string[]> {
  const canonicalCandidates = await Promise.all(
    candidatePaths.map(async (candidatePath) => realpath(resolve(repositoryRoot, candidatePath))),
  );
  const selectedPaths: string[] = [];
  for (const indexPath of canonicalIndexPaths) {
    const canonicalIndexPath = await resolvePresentCanonicalIndexPath(repositoryRoot, indexPath);
    if (canonicalIndexPath !== null && canonicalCandidates.some((candidatePath) => isWithin(candidatePath, canonicalIndexPath))) {
      selectedPaths.push(indexPath);
    }
  }
  return selectedPaths;
}

export async function scanIndexFreshness(repositoryRoot: string, candidatePaths: readonly string[]): Promise<readonly HealthFinding[]> {
  const documents = await collectMarkdownDocuments(repositoryRoot, candidatePaths);
  const indexDocuments = documents.filter((document) => canonicalIndexPathSet.has(document.relativePath));
  const findings: HealthFinding[] = [];
  for (const document of indexDocuments) {
    const targets = new Map<string, string>();
    for (const link of extractLinks(document.content)) {
      const result = await validateTarget(repositoryRoot, document.absolutePath, link.target);
      if (result !== null) {
        const message = result === "missing"
          ? `Missing local index target: ${link.target}`
          : result === "unsafe"
            ? `Unsafe local index target: ${link.target}`
            : `Unreadable local index target: ${link.target}`;
        findings.push({ checkId: "index", severity: "error", relativePath: document.relativePath, line: link.line, message });
      }

      const target = stripFragment(link.target);
      if (target.length === 0 || isExternalTarget(link.target)) continue;
      const normalizedPath = normalizeIndexTargetPath(document.absolutePath, target);
      if (!isWithin(repositoryRoot, normalizedPath)) continue;
      const normalizedKey = normalizedPath.toLowerCase();
      if (targets.has(normalizedKey)) {
        findings.push({
          checkId: "index",
          severity: "error",
          relativePath: document.relativePath,
          line: link.line,
          message: `Duplicate canonical index target: ${link.target}`,
        });
      } else {
        targets.set(normalizedKey, link.target);
      }
    }
  }
  return redactHealthFindings(findings);
}
