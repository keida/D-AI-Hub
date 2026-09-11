import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

export function resolveDefaultMemoryDatabasePath(environment: NodeJS.ProcessEnv = process.env, homeDirectory: string = homedir()): string {
  const fallbackDirectory = process.platform === "win32"
    ? join(homeDirectory, "AppData", "Local")
    : process.platform === "darwin"
      ? join(homeDirectory, "Library", "Application Support")
      : join(homeDirectory, ".local", "share");
  const configuredDirectory = process.platform === "win32"
    ? environment.LOCALAPPDATA
    : process.platform === "darwin"
      ? undefined
      : environment.XDG_DATA_HOME;
  const baseDirectory = configuredDirectory !== undefined && isAbsolute(configuredDirectory)
    ? configuredDirectory
    : fallbackDirectory;
  return resolve(join(baseDirectory, "D-AI-Hub", "memory", "memory.sqlite"));
}

export function resolveLocalMemoryScopeId(memoryDatabasePath: string): string {
  const memoryRoot = resolve(dirname(memoryDatabasePath));
  return `d-ai-local-${createHash("sha256").update(memoryRoot, "utf8").digest("hex").slice(0, 32)}`;
}
