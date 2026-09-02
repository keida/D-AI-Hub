import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

/** Resolve filesystem aliases while retaining any not-yet-created descendant path. */
export async function canonicalPath(value: string): Promise<string> {
  let candidate = resolve(value);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments);
    } catch (error: unknown) {
      const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : null;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}
