import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexCLI } from "../../src/entry/codex-cli.js";

describe("Codex D-AI CLI", () => {
  it("fails closed with task-selection instructions in a fresh unrelated workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-codex-entry-"));
    try {
      const result = await runCodexCLI([
        "--workspace",
        workspacePath,
        "--command",
        "@D-AI close",
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.response).toMatchObject({
        taskId: "unassigned",
        environment: "codex",
        status: "blocked",
      });
      expect(result.response.message).toMatch(/No active D-AI task matches this workspace.*--task <task-id>/i);
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
