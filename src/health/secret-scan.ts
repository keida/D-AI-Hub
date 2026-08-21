import type { HealthFinding } from "./types.js";
import { redactHealthFindings } from "./redaction.js";
import { collectRepositoryFiles, readFatalUtf8File } from "./repository-files.js";

interface TextDocument {
  readonly relativePath: string;
  readonly content: string;
}

interface SecretPattern {
  readonly category: string;
  readonly expression: RegExp;
}

const secretPatterns: readonly SecretPattern[] = [
  { category: "private-key", expression: /-----BEGIN\s+(?:[A-Z]+\s+)?PRIVATE\s+KEY-----/u },
  { category: "token", expression: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u },
  { category: "api-key", expression: /\b(?:api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{16,})["']?/iu },
  { category: "password", expression: /\b(?:[A-Z][A-Z0-9_]*_)?(?:PASSWORD|PASSWD)\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{12,})["']?/iu },
  { category: "secret-assignment", expression: /\b(?:[A-Z][A-Z0-9_]*_)?SECRET\s*[:=]\s*["']?([A-Za-z0-9_+/=-]{12,})["']?/u },
];

function compareStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function isPlaceholder(value: string): boolean {
  const normalized = value.toLowerCase();
  return /^(?:replace[_-]?me(?:[_-]?placeholder)?|placeholder|redacted(?:[_-]?(?:secret|token|api[_-]?key|value))?(?:[_-]?(?:here|value))?|change[_-]?me|your[_-]?(?:api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|secret|token)(?:[_-]?(?:here|value))?|(?:example|dummy|test)[_-]?(?:api[_-]?key|access[_-]?key|client[_-]?secret|password|passwd|secret|token)(?:[_-]?(?:here|value))?)$/u.test(normalized);
}

function hasSecret(pattern: SecretPattern, line: string): boolean {
  const match = pattern.expression.exec(line);
  if (match === null) return false;
  const value = match[1];
  return value === undefined || !isPlaceholder(value);
}

async function collectTextDocuments(repositoryRoot: string, candidatePaths: readonly string[]): Promise<readonly TextDocument[]> {
  const files = await collectRepositoryFiles(repositoryRoot, candidatePaths);
  const documents: TextDocument[] = [];
  for (const file of files) {
    const content = await readFatalUtf8File(repositoryRoot, file.absolutePath);
    if (content.includes("\0")) continue;
    documents.push({ relativePath: file.relativePath, content });
  }
  return documents.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

export async function scanSecrets(repositoryRoot: string, candidatePaths: readonly string[]): Promise<readonly HealthFinding[]> {
  const documents = await collectTextDocuments(repositoryRoot, candidatePaths);
  const findings: HealthFinding[] = [];
  for (const document of documents) {
    const lines = document.content.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) continue;
      for (const pattern of secretPatterns) {
        if (!hasSecret(pattern, line)) continue;
        findings.push({ checkId: "secret", severity: "warning", relativePath: document.relativePath, line: index + 1, message: `Secret-like content detected (${pattern.category})` });
      }
    }
  }
  return redactHealthFindings(findings);
}
