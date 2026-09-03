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

  it("accepts a natural-language discussion without creating durable task state", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-natural-discussion-"));
    try {
      const result = await runCodexCLI([
        "--workspace",
        workspacePath,
        "--command",
        "这个方案是不是应该改成 SQLite？",
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.response).toMatchObject({
        taskId: "unassigned",
        stage: "inspect",
        environment: "codex",
        status: "accepted",
        userIntent: { intent: "discuss", risk: "read-only" },
      });
      expect(result.response.message).toMatch(/no durable task was created or mutated/i);
      expect(await import("node:fs/promises").then(({ access }) => access(join(workspacePath, ".d-ai"))).catch(() => null)).toBeNull();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("blocks a natural-language delivery at the visible entry when no delivery authority is configured", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-natural-delivery-"));
    try {
      const result = await runCodexCLI([
        "--workspace",
        workspacePath,
        "--command",
        "fix the project and create a PR",
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.response).toMatchObject({ status: "blocked", userIntent: { intent: "delivery" } });
      expect(result.response.message).toMatch(/publication authority/i);
      expect(result.response.deliveryResult).toMatchObject({
        status: "blocked",
        focusedTest: "not-run",
        typecheck: "not-run",
        publicationStatus: "PENDING",
        mergePerformed: "NO",
      });
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs the natural-language delivery boundary end-to-end and reports execution is required", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-natural-local-plan-"));
    try {
      const result = await runCodexCLI([
        "--workspace",
        workspacePath,
        "--command",
        "那就改成 SQLite。",
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.response).toMatchObject({
        status: "blocked",
        userIntent: { intent: "delivery", riskLevel: 1 },
        deliveryResult: {
          status: "blocked",
          riskLevel: 1,
          changes: [],
          focusedTest: "not-run",
          typecheck: "not-run",
          publicationStatus: "PENDING",
          platforms: { windows: "PENDING", linux: "PENDING" },
          mergePerformed: "NO",
        },
      });
      expect(result.response.message).toContain("Task: unassigned");
      expect(result.response.message).toContain("actual implementation must continue");
      expect(result.response.message).toContain("Merge performed: NO");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
