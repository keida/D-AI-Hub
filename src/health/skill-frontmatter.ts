import { basename, dirname } from "node:path";
import { parseDocument } from "yaml";
import { isSafeSkillName } from "../skills/registry.js";
import type { HealthFinding } from "./types.js";
import { redactHealthFindings } from "./redaction.js";
import { collectRepositoryFiles, readFatalUtf8File } from "./repository-files.js";

interface SkillDocument {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly content: string;
}

interface ParsedSkill {
  readonly name: string;
  readonly nameLine: number;
}

function compareStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function isSkillPath(relativePath: string): boolean {
  return (relativePath.startsWith("skills/custom/") || relativePath.startsWith(".agents/skills/")) && relativePath.endsWith("/SKILL.md");
}

async function collectSkillDocuments(repositoryRoot: string, candidatePaths: readonly string[]): Promise<readonly SkillDocument[]> {
  const files = await collectRepositoryFiles(repositoryRoot, candidatePaths);
  const documents = await Promise.all(files
    .filter((file) => isSkillPath(file.relativePath))
    .map(async (file): Promise<SkillDocument> => ({
      absolutePath: file.absolutePath,
      relativePath: file.relativePath,
      content: await readFatalUtf8File(repositoryRoot, file.absolutePath),
    })));
  return documents.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

function lineNumber(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function parseSkillFrontmatter(content: string): { readonly parsed: ParsedSkill | null; readonly findingMessage: string | null; readonly line: number } {
  const opening = /^---\r?\n/u.exec(content);
  if (opening === null) return { parsed: null, findingMessage: "Missing Skill frontmatter", line: 1 };
  const closingPattern = /^---\s*$/gmu;
  closingPattern.lastIndex = opening[0].length;
  const closing = closingPattern.exec(content);
  if (closing === null) return { parsed: null, findingMessage: "Malformed Skill frontmatter", line: 1 };
  const yamlText = content.slice(opening[0].length, closing.index);
  const document = parseDocument(yamlText);
  if (document.errors.length > 0) return { parsed: null, findingMessage: "Malformed Skill frontmatter", line: 1 };
  const name = document.get("name");
  const description = document.get("description");
  if (typeof name !== "string" || name.trim().length === 0) {
    return { parsed: null, findingMessage: "Skill frontmatter requires non-empty name", line: 1 };
  }
  if (typeof description !== "string" || description.trim().length === 0) {
    return { parsed: null, findingMessage: "Skill frontmatter requires non-empty description", line: 1 };
  }
  const nameOffset = yamlText.search(/(^|\n)\s*name\s*:/u);
  return {
    parsed: { name: name.trim(), nameLine: nameOffset === -1 ? 1 : lineNumber(yamlText, nameOffset) + 1 },
    findingMessage: null,
    line: 1,
  };
}

export async function scanSkillFrontmatter(repositoryRoot: string, candidatePaths: readonly string[]): Promise<readonly HealthFinding[]> {
  const documents = await collectSkillDocuments(repositoryRoot, candidatePaths);
  const findings: HealthFinding[] = [];
  const canonicalNames = new Map<string, readonly { readonly document: SkillDocument; readonly parsed: ParsedSkill }[]>();

  for (const document of documents) {
    const result = parseSkillFrontmatter(document.content);
    if (result.findingMessage !== null) {
      findings.push({ checkId: "skill-frontmatter", severity: "error", relativePath: document.relativePath, line: result.line, message: result.findingMessage });
      continue;
    }
    if (result.parsed === null) continue;
    if (!isSafeSkillName(result.parsed.name)) {
      findings.push({
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: document.relativePath,
        line: result.parsed.nameLine,
        message: `Unsafe Skill name: ${result.parsed.name}`,
      });
      continue;
    }
    const directoryName = basename(dirname(document.absolutePath));
    if (directoryName !== result.parsed.name) {
      const skillKind = document.relativePath.startsWith("skills/custom/") ? "Canonical" : "Compatibility";
      findings.push({
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: document.relativePath,
        line: result.parsed.nameLine,
        message: `${skillKind} Skill directory ${directoryName} must match frontmatter name ${result.parsed.name}`,
      });
    }
    if (!document.relativePath.startsWith("skills/custom/")) continue;
    const existing = canonicalNames.get(result.parsed.name) ?? [];
    canonicalNames.set(result.parsed.name, [...existing, { document, parsed: result.parsed }]);
  }

  for (const entries of canonicalNames.values()) {
    if (entries.length < 2) continue;
    for (const entry of entries) {
      findings.push({
        checkId: "skill-frontmatter",
        severity: "error",
        relativePath: entry.document.relativePath,
        line: entry.parsed.nameLine,
        message: `Duplicate canonical Skill name: ${entry.parsed.name}`,
      });
    }
  }

  return [...redactHealthFindings(findings)].sort((left, right) => compareStrings(left.relativePath, right.relativePath) || (left.line ?? 0) - (right.line ?? 0) || compareStrings(left.message, right.message));
}
