import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand, type CommandResult } from "../../src/adapters/command-runner.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";

const temporaryRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-memory-cli-"));
  temporaryRoots.push(root);
  return root;
}

async function runMemoryCLI(argumentsList: readonly string[]): Promise<CommandResult> {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "node_modules/.bin/tsx";
  const commandArguments = process.platform === "win32"
    ? ["/d", "/s", "/c", ".\\node_modules\\.bin\\tsx.cmd", "src/memory/memory-cli.ts", ...argumentsList]
    : ["src/memory/memory-cli.ts", ...argumentsList];
  try {
    return await runCommand({
      command,
      arguments: commandArguments,
      cwd: process.cwd(),
      timeoutMs: 20_000,
    });
  } catch (error) {
    const result = (error as { result?: CommandResult }).result;
    if (result === undefined) throw error;
    return result;
  }
}

function parseJSON(result: CommandResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function initializeDatabase(databasePath: string): Promise<void> {
  const store = new LocalSqliteMemoryStore({
    databasePath,
    workspacePath: join(databasePath, ".."),
    mode: "writer",
    scopeId: "d-ai-hub",
    writerId: "primary-device",
  });
  store.close();
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("memory CLI", () => {
  it("puts, restarts with get, exports, and imports the same memory ID", async () => {
    const root = await createRoot();
    const writerDatabase = join(root, "writer.sqlite");
    const readerDatabase = join(root, "reader.sqlite");
    const bundleDirectory = join(root, "bundle");
    const common = ["--database", writerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device"];

    const put = await runMemoryCLI([
      "put", ...common, "--mode", "writer", "--memory-id", "note-1", "--value", '{"text":"hello"}',
      "--recorded-at", "2026-08-28T00:00:00.000Z",
    ]);
    expect(put.exitCode).toBe(0);
    expect(parseJSON(put)).toMatchObject({ memoryId: "note-1", sequence: 1 });

    const get = await runMemoryCLI(["get", ...common, "--mode", "reader", "--memory-id", "note-1"]);
    expect(get.exitCode).toBe(0);
    expect(parseJSON(get)).toMatchObject({ memoryId: "note-1", value: { text: "hello" } });

    const exported = await runMemoryCLI([
      "export", ...common, "--mode", "reader", "--bundle", bundleDirectory, "--bundle-id", "bundle-1",
      "--created-at", "2026-08-28T00:02:00.000Z",
    ]);
    expect(exported.exitCode).toBe(0);
    expect(parseJSON(exported)).toMatchObject({ bundleId: "bundle-1", recordCount: 1 });
    await expect(access(join(bundleDirectory, "records.jsonl"))).resolves.toBeUndefined();

    await initializeDatabase(readerDatabase);
    const imported = await runMemoryCLI([
      "import", "--database", readerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader", "--bundle", bundleDirectory,
    ]);
    expect(imported.exitCode).toBe(0);
    expect(parseJSON(imported)).toMatchObject({ outcome: "IMPORTED", bundleId: "bundle-1", importedCount: 1 });

    const readerGet = await runMemoryCLI([
      "get", "--database", readerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader", "--memory-id", "note-1",
    ]);
    expect(readerGet.exitCode).toBe(0);
    expect(parseJSON(readerGet)).toMatchObject({ memoryId: "note-1", value: { text: "hello" } });
  }, 60_000);

  it("rejects reader-mode put with a non-zero exit and no SQLite mutation", async () => {
    const root = await createRoot();
    const databasePath = join(root, "reader.sqlite");
    await initializeDatabase(databasePath);

    const result = await runMemoryCLI([
      "put", "--database", databasePath, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader",
      "--memory-id", "note-blocked", "--value", '{"text":"should-not-write"}', "--recorded-at", "2026-08-28T00:00:00.000Z",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toBe("");
    expect(parseJSON(result)).toMatchObject({ status: "blocked" });
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT memory_id FROM memory_records WHERE memory_id = ?").get("note-blocked");
      expect(row).toBeUndefined();
    } finally {
      database.close();
    }
    expect(result.stderr).toBe("");
  });

  it("creates a missing reader database only for a valid import and returns NOOP_DUPLICATE on repeat", async () => {
    const root = await createRoot();
    const writerDatabase = join(root, "writer.sqlite");
    const readerDatabase = join(root, "fresh-reader.sqlite");
    const bundleDirectory = join(root, "bundle");
    const writerArguments = ["--database", writerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device"];
    const put = await runMemoryCLI([
      "put", ...writerArguments, "--mode", "writer", "--memory-id", "fresh-note", "--value", '{"text":"fresh"}',
      "--recorded-at", "2026-08-28T00:00:00.000Z",
    ]);
    expect(put.exitCode).toBe(0);
    const exported = await runMemoryCLI([
      "export", ...writerArguments, "--mode", "reader", "--bundle", bundleDirectory, "--bundle-id", "fresh-bundle",
      "--created-at", "2026-08-28T00:02:00.000Z",
    ]);
    expect(exported.exitCode).toBe(0);
    await expect(access(readerDatabase)).rejects.toThrow();

    const importArguments = [
      "import", "--database", readerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader", "--bundle", bundleDirectory,
    ];
    const imported = await runMemoryCLI(importArguments);
    expect(imported.exitCode).toBe(0);
    expect(parseJSON(imported)).toMatchObject({ outcome: "IMPORTED", bundleId: "fresh-bundle", importedCount: 1 });
    await expect(access(readerDatabase)).resolves.toBeUndefined();
    const repeated = await runMemoryCLI(importArguments);
    expect(repeated.exitCode).toBe(0);
    expect(parseJSON(repeated)).toMatchObject({ outcome: "NOOP_DUPLICATE", bundleId: "fresh-bundle", importedCount: 0 });
    const readerGet = await runMemoryCLI([
      "get", "--database", readerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader", "--memory-id", "fresh-note",
    ]);
    expect(readerGet.exitCode).toBe(0);
    expect(parseJSON(readerGet)).toMatchObject({ memoryId: "fresh-note", value: { text: "fresh" } });
  }, 60_000);

  it("rejects a tampered bundle without creating a missing reader database", async () => {
    const root = await createRoot();
    const writerDatabase = join(root, "writer.sqlite");
    const readerDatabase = join(root, "tampered-reader.sqlite");
    const bundleDirectory = join(root, "bundle");
    const writerArguments = ["--database", writerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device"];
    expect((await runMemoryCLI([
      "put", ...writerArguments, "--mode", "writer", "--memory-id", "tampered-note", "--value", '{"text":"original"}',
      "--recorded-at", "2026-08-28T00:00:00.000Z",
    ])).exitCode).toBe(0);
    expect((await runMemoryCLI([
      "export", ...writerArguments, "--mode", "reader", "--bundle", bundleDirectory, "--bundle-id", "tampered-bundle",
      "--created-at", "2026-08-28T00:02:00.000Z",
    ])).exitCode).toBe(0);
    const recordsPath = join(bundleDirectory, "records.jsonl");
    const records = await readFile(recordsPath, "utf8");
    await writeFile(recordsPath, records.replace("original", "tampered"), "utf8");

    const result = await runMemoryCLI([
      "import", "--database", readerDatabase, "--workspace", root, "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader", "--bundle", bundleDirectory,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(parseJSON(result)).toMatchObject({ outcome: "BLOCKED" });
    await expect(access(readerDatabase)).rejects.toThrow();
  }, 60_000);

  it.each([
    ["unknown option", ["--unknown", "value"]],
    ["duplicate option", ["--mode", "reader", "--mode", "reader"]],
    ["missing option value", ["--memory-id"]],
  ])("rejects %s with a non-zero exit and stable JSON", async (_label, suffix) => {
    const result = await runMemoryCLI([
      "get", "--database", "missing.sqlite", "--workspace", process.cwd(), "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader", ...suffix,
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(parseJSON(result)).toMatchObject({ status: "blocked" });
    expect(result.stderr).toBe("");
  });

  it("requires an explicit workspace option", async () => {
    const result = await runMemoryCLI([
      "get", "--database", "missing.sqlite", "--scope", "d-ai-hub", "--writer", "primary-device", "--mode", "reader", "--memory-id", "note-1",
    ]);
    expect(result.exitCode).not.toBe(0);
    expect(parseJSON(result)).toMatchObject({ status: "blocked" });
    expect(String(parseJSON(result).message)).toMatch(/workspace/i);
  });

  it("uses the persisted workspace binding and blocks a different workspace", async () => {
    const root = await createRoot();
    const databasePath = join(root, "workspace-bound.sqlite");
    const firstWorkspace = join(root, "workspace-first");
    const secondWorkspace = join(root, "workspace-second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    const common = ["--database", databasePath, "--scope", "d-ai-hub", "--writer", "primary-device"];

    const put = await runMemoryCLI([
      "put", ...common, "--workspace", firstWorkspace, "--mode", "writer", "--memory-id", "workspace-note", "--value", '{"text":"hello"}',
      "--recorded-at", "2026-08-28T00:00:00.000Z",
    ]);
    expect(put.exitCode).toBe(0);
    const correct = await runMemoryCLI([
      "get", ...common, "--workspace", firstWorkspace, "--mode", "reader", "--memory-id", "workspace-note",
    ]);
    expect(correct.exitCode).toBe(0);
    expect(parseJSON(correct)).toMatchObject({ memoryId: "workspace-note" });
    const mismatched = await runMemoryCLI([
      "get", ...common, "--workspace", secondWorkspace, "--mode", "reader", "--memory-id", "workspace-note",
    ]);
    expect(mismatched.exitCode).not.toBe(0);
    expect(String(parseJSON(mismatched).message)).toMatch(/workspace/i);
  }, 60_000);
});
