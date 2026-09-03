import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexCLI } from "../../src/entry/codex-cli.js";

describe("natural-language delivery boundary", () => {
  it("executes the Level 1 local bounded-plan path through the real CLI entry", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-natural-integration-"));
    try {
      const result = await runCodexCLI([
        "--workspace",
        workspacePath,
        "--command",
        "那就改成 SQLite。",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.response.deliveryResult?.status).toBe("completed");
      expect(result.response.deliveryResult?.publicationStatus).toBe("PENDING");
      expect(result.response.deliveryResult?.formatted).toContain("Verification:");
      expect(result.response.deliveryResult?.formatted).toContain("Windows=PENDING");
      expect(result.response.deliveryResult?.formatted).toContain("Linux=PENDING");
      expect(result.response.deliveryResult?.formatted).toContain("Merge performed: NO");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
