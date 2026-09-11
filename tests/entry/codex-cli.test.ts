import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodexCLI } from "../../src/entry/codex-cli.js";
import { resolveDefaultMemoryDatabasePath, resolveLocalMemoryScopeId } from "../../src/memory/local-memory-path.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";

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
      expect(result.response.agentExecutionDirective).toMatchObject({
        kind: "codex-agent-delivery",
        requestText: "fix the project and create a PR",
        taskId: "unassigned",
        resumed: false,
        riskLevel: 2,
        expectedEndpoint: "review-ready-pr",
        publicationAuthorityRequired: true,
        mergeAllowed: false,
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

  it("accepts a validated curation payload through the CLI and reads back into an isolated SQLite override", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-curation-cli-"));
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-db-"));
    const payloadPath = join(workspacePath, "curation.json");
    const databasePath = join(databaseRoot, "isolated-memory.sqlite");
    try {
      await writeFile(payloadPath, JSON.stringify({
        version: 1,
        candidates: [{
          candidateId: "cli-fact",
          memoryId: "cli-fact",
          fact: "CLI supplied facts use a local SQLite seam.",
          category: "knowledge",
          source: "current-context",
          privacyRisk: "local-private",
        }],
      }), "utf8");

      const result = await runCodexCLI([
        "--workspace", workspacePath,
        "--command", "@D-AI 整理",
        "--curation-payload", payloadPath,
        "--memory-database", databasePath,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.response).toMatchObject({ status: "completed", message: expect.stringMatching(/Added=1|locally stored=YES/i) });
      expect(result.response.curationRecords).toMatchObject([{ memoryId: "cli-fact", decision: "ADD" }]);
      expect(result.response.message).toContain("Records=cli-fact:ADD");
      const reader = new LocalSqliteMemoryStore({ databasePath, workspacePath: dirname(databasePath), mode: "reader", scopeId: resolveLocalMemoryScopeId(databasePath), writerId: "primary-device" });
      try {
        await expect(reader.get("cli-fact")).resolves.toMatchObject({ value: { fact: "CLI supplied facts use a local SQLite seam." } });
      } finally {
        reader.close();
      }
      await expect(access(join(workspacePath, ".d-ai"))).rejects.toThrow();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
      await rm(databaseRoot, { recursive: true, force: true });
    }
  });

  it("does not serialize confidential fact content in public curation records", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-curation-cli-privacy-"));
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-db-privacy-"));
    const payloadPath = join(workspacePath, "curation.json");
    const confidentialFact = "WORKPLACE-CONFIDENTIAL-FACT-MUST-NOT-APPEAR-IN-RESPONSE";
    try {
      await writeFile(payloadPath, JSON.stringify({
        version: 1,
        candidates: [{
          candidateId: "confidential-fact",
          memoryId: "confidential-fact",
          fact: confidentialFact,
          category: "knowledge",
          source: "current-context",
          privacyRisk: "workplace-confidential",
        }],
      }), "utf8");

      const result = await runCodexCLI([
        "--workspace", workspacePath,
        "--command", "@D-AI 整理",
        "--curation-payload", payloadPath,
        "--memory-database", join(databaseRoot, "memory.sqlite"),
      ]);

      const serialized = JSON.stringify(result.response);
      expect(result.response).toMatchObject({ status: "completed", curationRecords: [{ memoryId: "confidential-fact", category: "knowledge", decision: "REJECT" }] });
      expect(result.response.message).toMatch(/Rejected=1|confidential-fact:REJECT/i);
      expect(serialized).not.toContain(confidentialFact);
      expect(serialized).not.toContain("summary");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
      await rm(databaseRoot, { recursive: true, force: true });
    }
  });

  it("returns SAFE NO with zero writes when curation has no supplied payload", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-curation-cli-empty-"));
    try {
      const result = await runCodexCLI(["--workspace", workspacePath, "--command", "@D-AI 整理"]);

      expect(result.exitCode).toBe(2);
      expect(result.response.message).toMatch(/SAFE TO DELETE ORIGINAL CHAT: NO|not captured/i);
      await expect(access(join(workspacePath, ".d-ai"))).rejects.toThrow();
      expect(resolveDefaultMemoryDatabasePath().toLowerCase()).not.toContain(workspacePath.toLowerCase());
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects an explicit memory database inside the configured workspace", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-curation-cli-local-db-"));
    try {
      await expect(runCodexCLI([
        "--workspace", workspacePath,
        "--command", "@D-AI 整理",
        "--memory-database", join(workspacePath, "memory.sqlite"),
      ])).rejects.toThrow(/outside the configured workspace/i);
      await expect(access(join(workspacePath, ".d-ai"))).rejects.toThrow();
      await expect(access(join(workspacePath, "memory.sqlite"))).rejects.toThrow();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects a missing curation payload before any durable or memory write", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-curation-cli-invalid-"));
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-db-invalid-"));
    const databasePath = join(databaseRoot, "isolated-memory.sqlite");
    try {
      const result = await runCodexCLI([
        "--workspace", workspacePath,
        "--command", "@D-AI 整理",
        "--curation-payload", join(workspacePath, "missing.json"),
        "--memory-database", databasePath,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.response.message).toMatch(/payload|readable|blocked/i);
      await expect(access(databasePath)).rejects.toThrow();
      await expect(access(join(workspacePath, ".d-ai"))).rejects.toThrow();
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
      await rm(databaseRoot, { recursive: true, force: true });
    }
  });

  it("rejects secret-shaped persisted identifiers before creating the memory database", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "d-ai-curation-cli-secret-"));
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-curation-db-secret-"));
    const payloadPath = join(workspacePath, "secret.json");
    const databasePath = join(databaseRoot, "isolated-memory.sqlite");
    try {
      await writeFile(payloadPath, JSON.stringify({
        version: 1,
        candidates: [{
          candidateId: "-----BEGIN PRIVATE KEY-----",
          memoryId: "safe-memory-id",
          fact: "A harmless-looking fact.",
          category: "knowledge",
          source: "current-context",
          privacyRisk: "local-private",
        }],
      }), "utf8");

      const result = await runCodexCLI([
        "--workspace", workspacePath,
        "--command", "@D-AI 整理",
        "--curation-payload", payloadPath,
        "--memory-database", databasePath,
      ]);

      expect(result.exitCode).toBe(2);
      expect(result.response.message).toMatch(/candidate|safe|secret/i);
      await expect(access(databasePath)).rejects.toThrow();
      await expect(access(join(workspacePath, ".d-ai"))).rejects.toThrow();
      expect(result.response.message).not.toContain("api-key-candidate");
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
      await rm(databaseRoot, { recursive: true, force: true });
    }
  });
});
