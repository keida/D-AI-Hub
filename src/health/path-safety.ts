import * as platformPath from "node:path";

export interface PathContainmentOperations {
  readonly sep: string;
  readonly isAbsolute: (candidatePath: string) => boolean;
  readonly relative: (fromPath: string, toPath: string) => string;
}

export function isPathWithinRoot(
  repositoryRoot: string,
  candidatePath: string,
  operations: PathContainmentOperations,
): boolean {
  const pathRelativeToRoot = operations.relative(repositoryRoot, candidatePath);
  return pathRelativeToRoot === "" || (
    pathRelativeToRoot !== ".."
    && !pathRelativeToRoot.startsWith(`..${operations.sep}`)
    && !operations.isAbsolute(pathRelativeToRoot)
  );
}

export function isPlatformPathWithinRoot(repositoryRoot: string, candidatePath: string): boolean {
  return isPathWithinRoot(repositoryRoot, candidatePath, platformPath);
}
