import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("local-first repository privacy boundary", () => {
  it("ignores private durable roots, machine bindings and SQLite but leaves approved bundle paths opt-in", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "d-ai-ignore-boundary-"));
    try {
      const init = spawnSync("git", ["init", "--initial-branch=main", workspace], { encoding: "utf8" });
      expect(init.error).toBeUndefined();
      expect(init.status).toBe(0);
      await writeFile(join(workspace, ".gitignore"), await readFile(fileURLToPath(new URL("../../.gitignore", import.meta.url)), "utf8"), "utf8");

      const privatePaths = [
        ".d-ai/task-123/state.json",
        "nested/.d-ai/task-456/recovery.json",
        ".agents/skills/d-ai/.runtime-root",
        "memory.sqlite",
        "memory.sqlite-wal",
        "memory.sqlite-shm",
      ];
      for (const path of privatePaths) {
        const result = spawnSync("git", ["-C", workspace, "check-ignore", "--no-index", "--quiet", "--", path], { encoding: "utf8" });
        expect(result.error).toBeUndefined();
        expect(result.status, `Private local artifact was not ignored: ${path}`).toBe(0);
      }

      const publicBundle = "memory-bundles/synthetic-public/manifest.json";
      const result = spawnSync("git", ["-C", workspace, "check-ignore", "--no-index", "--quiet", "--", publicBundle], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status, "Reviewed public-safe memory bundles must remain individually publishable").toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
    }
  });
});
