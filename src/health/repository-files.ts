import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { RepositoryHealthPathTraversalError, RepositoryHealthTextDecodingError } from "./errors.js";
import { isPlatformPathWithinRoot } from "./path-safety.js";

export interface RepositoryFile {
  readonly absolutePath: string;
  readonly relativePath: string;
}

const excludedDirectoryNames: ReadonlySet<string> = new Set([
  ".git",
  ".superpowers",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function compareStrings(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left.charCodeAt(index) - right.charCodeAt(index);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

export function toRepositoryRelativePath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function hasExcludedDirectorySegment(repositoryRoot: string, candidatePath: string): boolean {
  const relativePath = relative(repositoryRoot, candidatePath);
  if (relativePath === "") return false;
  return relativePath.split(/[\\/]+/u).some((segment) => excludedDirectoryNames.has(segment));
}

export async function collectRepositoryFiles(
  repositoryRoot: string,
  candidatePaths: readonly string[],
): Promise<readonly RepositoryFile[]> {
  const canonicalRepositoryRoot = await realpath(repositoryRoot);
  const files = new Map<string, RepositoryFile>();
  const visitedDirectories = new Set<string>();

  async function visit(candidatePath: string): Promise<void> {
    if (!isPlatformPathWithinRoot(canonicalRepositoryRoot, candidatePath)) {
      throw new RepositoryHealthPathTraversalError(`Repository path escapes repository root: ${candidatePath}`);
    }
    if (hasExcludedDirectorySegment(canonicalRepositoryRoot, candidatePath)) return;

    const canonicalPath = await realpath(candidatePath);
    if (!isPlatformPathWithinRoot(canonicalRepositoryRoot, canonicalPath)) {
      throw new RepositoryHealthPathTraversalError(`Repository path escapes repository root: ${candidatePath}`);
    }
    if (hasExcludedDirectorySegment(canonicalRepositoryRoot, canonicalPath)) return;

    const status = await stat(canonicalPath);
    if (status.isDirectory()) {
      if (visitedDirectories.has(canonicalPath)) return;
      visitedDirectories.add(canonicalPath);
      const entries = [...await readdir(canonicalPath, { withFileTypes: true })]
        .sort((left, right) => compareStrings(left.name, right.name));
      for (const entry of entries) {
        if (excludedDirectoryNames.has(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) continue;
        await visit(resolve(canonicalPath, entry.name));
      }
      return;
    }
    if (!status.isFile()) return;
    const relativePath = toRepositoryRelativePath(canonicalRepositoryRoot, canonicalPath);
    files.set(relativePath, { absolutePath: canonicalPath, relativePath });
  }

  for (const candidatePath of candidatePaths) {
    await visit(resolve(canonicalRepositoryRoot, candidatePath));
  }
  return [...files.values()].sort((left, right) => compareStrings(left.relativePath, right.relativePath));
}

export async function readFatalUtf8File(repositoryRoot: string, absolutePath: string): Promise<string> {
  const bytes = await readFile(absolutePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new RepositoryHealthTextDecodingError(toRepositoryRelativePath(repositoryRoot, absolutePath));
    }
    throw error;
  }
}
