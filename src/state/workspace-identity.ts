import { canonicalPath } from "../domain/canonical-path.js";

const workspaceIdentityPrefix = "identity:workspace:";
const workspaceHashPattern = /^[a-f0-9]{64}$/i;

// The path is the stable workspace-selection key. The hash is a bootstrap snapshot
// fingerprint and is format-checked here; recomputing it during discovery would
// reject legitimate active tasks after the workspace contents change.
export function canonicalWorkspaceIdentityPath(contextManifest: readonly string[]): string | null {
  const workspaceEntries = contextManifest.filter((entry) => entry.startsWith(workspaceIdentityPrefix));
  if (workspaceEntries.length !== 1) return null;
  const payload = workspaceEntries[0]!.slice(workspaceIdentityPrefix.length);
  const separator = payload.lastIndexOf(":");
  if (separator <= 0) return null;
  const path = payload.slice(0, separator);
  const hash = payload.slice(separator + 1);
  return workspaceHashPattern.test(hash) ? path : null;
}

export async function matchesWorkspaceIdentity(contextManifest: readonly string[], workspacePath: string): Promise<boolean> {
  const storedPath = canonicalWorkspaceIdentityPath(contextManifest);
  if (storedPath === null) return false;
  const [storedCanonicalPath, configuredCanonicalPath] = await Promise.all([
    canonicalPath(storedPath),
    canonicalPath(workspacePath),
  ]);
  return process.platform === "win32"
    ? storedCanonicalPath.toLowerCase() === configuredCanonicalPath.toLowerCase()
    : storedCanonicalPath === configuredCanonicalPath;
}
