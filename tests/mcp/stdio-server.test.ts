import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createSdkMcpServer,
  type CurateMcpDependencies,
} from "../../src/mcp/stdio-server.js";
import { curateCurrentContext, type CurationCandidate, type CurationResult } from "../../src/curation/local-curation.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";
import { runCommand } from "../../src/adapters/command-runner.js";
import { createConfiguredCurationHandler } from "../../src/runtime/d-ai-runtime.js";
import type { TaskState } from "../../src/domain/types.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

const temporaryRoots: string[] = [];

function candidate(overrides: Partial<CurationCandidate> = {}): CurationCandidate {
  return {
    candidateId: "mcp-fact-1",
    memoryId: "mcp-fact-1",
    fact: "MCP curation delegates to the existing local curation service.",
    category: "knowledge",
    source: "current-context",
    privacyRisk: "local-private",
    ...overrides,
  };
}

function payload(...candidates: CurationCandidate[]): string {
  return JSON.stringify({ version: 1, candidates });
}

async function prepareGitWorkspace(root: string): Promise<void> {
  await runCommand({ command: "git", arguments: ["init", "--initial-branch=main", root], cwd: null });
  await writeFile(join(root, "fixture.txt"), "mcp fixture\n", "utf8");
  await runCommand({ command: "git", arguments: ["config", "user.email", "d-ai@example.test"], cwd: root });
  await runCommand({ command: "git", arguments: ["config", "user.name", "D-AI Test"], cwd: root });
  await runCommand({ command: "git", arguments: ["add", "fixture.txt"], cwd: root });
  await runCommand({ command: "git", arguments: ["commit", "-m", "mcp fixture"], cwd: root });
  await runCommand({ command: "git", arguments: ["remote", "add", "origin", "https://github.com/acme/d-ai.git"], cwd: root });
}

function seededTask(root: string, taskId: string): TaskState {
  const identityHash = createHash("sha256").update(root, "utf8").digest("hex");
  return {
    taskId,
    goal: "Seed an exact MCP project identity",
    constraints: [],
    environment: "codex",
    stage: "bootstrap",
    role: "analyst",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: [`identity:workspace:${root}:${identityHash}`, "remote-repository:github.com/acme/d-ai"],
    handoffState: "none",
    verificationEvidence: [],
    recoveryPoint: null,
    approvalState: "not-required",
    criticalUnsavedContext: [],
    durableContext: null,
  };
}

function toolResponseText(response: unknown): Record<string, unknown> {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1 || typeof content[0] !== "object" || content[0] === null || typeof (content[0] as { text?: unknown }).text !== "string") {
    throw new Error(`Expected one SDK text content block: ${JSON.stringify(response)}`);
  }
  return JSON.parse((content[0] as { text: string }).text) as Record<string, unknown>;
}

async function connectClient(dependencies: CurateMcpDependencies): Promise<{ readonly client: Client; readonly server: ReturnType<typeof createSdkMcpServer> }> {
  const server = createSdkMcpServer(dependencies);
  const client = new Client({ name: "d-ai-mcp-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

async function callCurate(client: Client, argumentsValue: unknown): Promise<Record<string, unknown> | null> {
  try {
    return toolResponseText(await client.callTool({ name: "curate", arguments: argumentsValue as Record<string, unknown> }));
  } catch {
    return null;
  }
}

async function createIsolatedDependencies(): Promise<{ readonly dependencies: CurateMcpDependencies; readonly store: LocalSqliteMemoryStore; readonly root: string }> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-mcp-"));
  temporaryRoots.push(root);
  const store = new LocalSqliteMemoryStore({
    databasePath: join(root, "memory.sqlite"),
    workspacePath: root,
    mode: "writer",
    scopeId: "d-ai-mcp-test",
    writerId: "mcp-test",
  });
  const dependencies: CurateMcpDependencies = {
    curate: (candidates, projectHint): Promise<CurationResult> => curateCurrentContext(store, candidates, { knownProjectTaskId: projectHint === "task-existing" ? projectHint : null }),
  };
  return { dependencies, store, root };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("local MCP curation bridge", () => {
  it("starts the official stdio transport and enumerates exactly curate", async () => {
    const child = spawn(process.execPath, [join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/mcp/stdio-server.ts"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => output.push(chunk));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.1.0" } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    child.stdin.end();
    const exitCode = await new Promise<number | null>((resolveExit) => child.once("close", resolveExit));
    const responses = output.join("").trim().split(/\r?\n/gu).filter(Boolean).map((line) => JSON.parse(line) as { result?: { tools?: Array<{ name: string }> } });
    expect(exitCode).toBe(0);
    expect(responses).toHaveLength(2);
    expect(responses[1]?.result?.tools?.map((tool) => tool.name)).toEqual(["curate"]);
  });

  it("lists exactly one curate tool and performs ADD then NOOP through MCP", async () => {
    const { dependencies, store } = await createIsolatedDependencies();
    const { client, server } = await connectClient(dependencies);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(["curate"]);

      const firstResponse = await client.callTool({ name: "curate", arguments: { payload: payload(candidate()), source: "manual" } });
      const first = toolResponseText(firstResponse);
      expect(first).toMatchObject({ decision: "ADD", memoryId: "mcp-fact-1", persisted: true, readBackVerified: true, safeToDeleteSuppliedPayload: "YES" });
      expect(await store.get("mcp-fact-1")).toMatchObject({ value: { source: "current-context" } });

      const secondResponse = await client.callTool({ name: "curate", arguments: { payload: payload(candidate()), source: "manual" } });
      const second = toolResponseText(secondResponse);
      expect(second).toMatchObject({ decision: "NOOP", memoryId: "mcp-fact-1", persisted: true, readBackVerified: true });
      expect(await store.listAfter(0)).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it("classifies a unique exact project hint and blocks ambiguous or missing hints without durable task creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-mcp-project-"));
    const databaseRoot = await mkdtemp(join(tmpdir(), "d-ai-mcp-project-db-"));
    temporaryRoots.push(root, databaseRoot);
    await prepareGitWorkspace(root);
    const durableRoot = join(root, ".d-ai");
    const durableStore = new FileDurableContextStore(durableRoot);
    const uniqueTask = seededTask(root, "task-mcp-unique");
    await durableStore.createIfAbsent(uniqueTask);
    const curate = createConfiguredCurationHandler({ workspacePath: root, durableRoot, memoryDatabasePath: join(databaseRoot, "memory.sqlite") });
    const { client, server } = await connectClient({ curate });
    const beforeUnique = await durableStore.load(uniqueTask.taskId);

    const accepted = (await callCurate(client, {
      payload: payload(candidate({ category: "project-memory", projectTaskId: uniqueTask.taskId, memoryId: "mcp-unique", candidateId: "mcp-unique" })),
      source: "codex",
      projectHint: uniqueTask.taskId,
    }))!;
    expect(accepted).toMatchObject({ decision: "ADD", memoryId: "mcp-unique", persisted: true, readBackVerified: true });
    expect(await durableStore.load(uniqueTask.taskId)).toEqual(beforeUnique);

    await durableStore.createIfAbsent(seededTask(root, "task-mcp-second"));
    const beforeAmbiguous = await readdir(durableRoot);
    const ambiguous = (await callCurate(client, {
      payload: payload(candidate({ category: "project-memory", projectTaskId: "task-mcp-ambiguous", memoryId: "mcp-ambiguous", candidateId: "mcp-ambiguous" })),
      source: "codex",
    }))!;
    expect(ambiguous).toMatchObject({ decision: "DEFER", persisted: false, safeToDeleteSuppliedPayload: "NO" });
    expect(await readdir(durableRoot)).toEqual(beforeAmbiguous);

    const missing = (await callCurate(client, {
      payload: payload(candidate({ category: "project-memory", projectTaskId: "task-mcp-missing", memoryId: "mcp-missing", candidateId: "mcp-missing" })),
      source: "codex",
      projectHint: "task-mcp-missing",
    }))!;
    expect(missing).toMatchObject({ decision: "DEFER", persisted: false, safeToDeleteSuppliedPayload: "NO" });
    expect(await readdir(durableRoot)).toEqual(beforeAmbiguous);
    await client.close();
    await server.close();
  });

  it("rejects malformed, oversized, unknown, path-like, SQL-like, and command-like inputs before the curator", async () => {
    const curate = vi.fn(async (): Promise<CurationResult> => {
      throw new Error("must not be called");
    });
    const { client, server } = await connectClient({ curate });
    const cases: unknown[] = [
      { payload: "", source: "manual" },
      { payload: "{" + "x".repeat(20_000), source: "manual" },
      { payload: payload(candidate()), source: "manual", extra: true },
      { payload: JSON.stringify({ version: 1, candidates: [], path: "C:\\secret" }), source: "manual" },
      { payload: JSON.stringify({ version: 1, candidates: [], sql: "DELETE FROM memory" }), source: "manual" },
      { payload: JSON.stringify({ version: 1, candidates: [], command: "powershell Remove-Item" }), source: "manual" },
      { payload: "not-json", source: "manual" },
    ];

    for (const input of cases) {
      const response = await callCurate(client, input);
      if (response !== null) expect(response.persisted).toBe(false);
    }
    expect(curate).not.toHaveBeenCalled();
    await client.close();
    await server.close();
  });

  it("rejects workplace-risk facts and fails closed for project hints without creating tasks", async () => {
    const { dependencies, store, root } = await createIsolatedDependencies();
    const { client, server } = await connectClient(dependencies);
    try {
      const rejected = (await callCurate(client, {
        payload: payload(candidate({ privacyRisk: "workplace-confidential" })),
        source: "codex",
      }))!;
      expect(rejected).toMatchObject({ decision: "REJECT", persisted: false, safeToDeleteSuppliedPayload: "NO" });

      const accepted = (await callCurate(client, {
        payload: payload(candidate({ category: "project-memory", projectTaskId: "task-existing", memoryId: "mcp-project-1", candidateId: "mcp-project-1" })),
        source: "codex",
        projectHint: "task-existing",
      }))!;
      expect(accepted).toMatchObject({ decision: "ADD", memoryId: "mcp-project-1", persisted: true, readBackVerified: true });

      const deferred = (await callCurate(client, {
        payload: payload(candidate({ category: "project-memory", projectTaskId: "task-missing" })),
        source: "codex",
        projectHint: "task-missing",
      }))!;
      expect(deferred).toMatchObject({ decision: "DEFER", persisted: false, safeToDeleteSuppliedPayload: "NO" });
      expect(await store.listAfter(0)).toHaveLength(1);
      expect((await readdir(root)).filter((entry) => entry.includes("task"))).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it("does not expose filesystem, command, SQL, resource, or prompt capabilities", async () => {
    const { dependencies, store } = await createIsolatedDependencies();
    const { client, server } = await connectClient(dependencies);
    try {
      const listed = await client.listTools();
      const tool = listed.tools[0]!;
      expect(tool.name).toBe("curate");
      const inputSchema = tool.inputSchema as { additionalProperties?: unknown; properties?: Record<string, unknown> };
      expect(inputSchema.additionalProperties).toBe(false);
      expect(inputSchema.properties).toEqual(expect.objectContaining({ payload: expect.anything(), source: expect.anything() }));
      expect(Object.keys(inputSchema.properties ?? {}).sort()).toEqual(["payload", "projectHint", "source"]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it("does not leak downstream filesystem or SQL error details through the official SDK path", async () => {
    const curate = vi.fn(async (): Promise<CurationResult> => {
      throw new Error("SQLITE_CANTOPEN C:\\Users\\Private\\memory.sqlite");
    });
    const { client, server } = await connectClient({ curate });
    try {
      const response = (await callCurate(client, { payload: payload(candidate()), source: "manual" }))!;
      expect(response).toMatchObject({ decision: "DEFER", persisted: false, safeToDeleteSuppliedPayload: "NO" });
      expect(response.message).not.toContain("SQLITE_CANTOPEN");
      expect(response.message).not.toContain("Private");
      expect(response.message).toContain("no internal details");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
