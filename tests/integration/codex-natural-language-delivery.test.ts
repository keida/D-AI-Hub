import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexCLI } from "../../src/entry/codex-cli.js";

describe("natural-language delivery boundary", () => {
  it("executes the natural-language delivery boundary through the real CLI entry", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-natural-integration-"));
    try {
      const result = await runCodexCLI([
        "--workspace",
        workspacePath,
        "--command",
        "那就改成 SQLite。",
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.response.deliveryResult?.status).toBe("blocked");
      expect(result.response.deliveryResult?.publicationStatus).toBe("PENDING");
      expect(result.response.deliveryResult?.focusedTest).toBe("not-run");
      expect(result.response.deliveryResult?.formatted).toContain("D-AI Delivery Result");
      expect(result.response.deliveryResult?.formatted).toContain("Windows: PENDING");
      expect(result.response.deliveryResult?.formatted).toContain("Linux: PENDING");
      expect(result.response.deliveryResult?.formatted).toContain("Merge performed: NO");
      expect(result.response.deliveryResult?.formatted).toContain("actual implementation must continue");
      expect(result.response.agentExecutionDirective).toMatchObject({
        kind: "codex-agent-delivery",
        requestText: "那就改成 SQLite。",
        riskLevel: 1,
        expectedEndpoint: "local-change",
        publicationAuthorityRequired: false,
        mergeAllowed: false,
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
