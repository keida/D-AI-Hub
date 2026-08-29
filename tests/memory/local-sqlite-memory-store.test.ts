import { access, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";

const temporaryRoots: string[] = [];

async function createDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-memory-store-"));
  temporaryRoots.push(root);
  return join(root, "memory.sqlite");
}

function createWriter(databasePath: string): LocalSqliteMemoryStore {
  return new LocalSqliteMemoryStore({
    databasePath,
    workspacePath: join(databasePath, ".."),
    mode: "writer",
    scopeId: "d-ai-hub",
    writerId: "primary-device",
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalSqliteMemoryStore", () => {
  it("retains a writer record after the database is reopened", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);

    const stored = await writer.put({
      memoryId: "note-1",
      value: { text: "hello" },
      recordedAt: "2026-08-28T00:00:00.000Z",
    });
    writer.close();

    const reopened = createWriter(databasePath);
    expect(stored).toMatchObject({
      memoryId: "note-1",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
      sequence: 1,
      value: { text: "hello" },
      recordedAt: "2026-08-28T00:00:00.000Z",
    });
    expect(await reopened.get("note-1")).toMatchObject({
      memoryId: "note-1",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
      sequence: 1,
      value: { text: "hello" },
      recordedAt: "2026-08-28T00:00:00.000Z",
    });
    reopened.close();
  });

  it("rejects a reader-mode write without creating a record", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    writer.close();
    const reader = new LocalSqliteMemoryStore({
      databasePath,
      workspacePath: join(databasePath, ".."),
      mode: "reader",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    });

    await expect(reader.put({
      memoryId: "note-1",
      value: { text: "hello" },
      recordedAt: "2026-08-28T00:00:00.000Z",
    })).rejects.toThrow(/reader mode/i);
    expect(await reader.get("note-1")).toBeNull();
    reader.close();
  });

  it("rejects a reader-mode open for a missing database without creating it", async () => {
    const databasePath = await createDatabasePath();

    expect(() => new LocalSqliteMemoryStore({
      databasePath,
      workspacePath: join(databasePath, ".."),
      mode: "reader",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    })).toThrow();
    await expect(access(databasePath)).rejects.toThrow();
  });

  it("rejects an invalid runtime mode before opening SQLite", async () => {
    const databasePath = await createDatabasePath();

    expect(() => new LocalSqliteMemoryStore({
      databasePath,
      workspacePath: join(databasePath, ".."),
      mode: "invalid" as never,
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    })).toThrow(/mode/i);
    await expect(access(databasePath)).rejects.toThrow();
  });

  it("rejects secret-shaped input before persisting it", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);

    await expect(writer.put({
      memoryId: "note-secret",
      value: { token: "ghp_123456789012345678901234567890" },
      recordedAt: "2026-08-28T00:00:00.000Z",
    })).rejects.toThrow(/secret/i);
    expect(await writer.get("note-secret")).toBeNull();
    writer.close();
  });

  it("rejects a getter that changes from benign content to a secret without persisting a row", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    let reads = 0;
    const value = {
      get text(): string {
        reads += 1;
        return reads <= 2 ? "safe" : "ghp_123456789012345678901234567890";
      },
    };

    try {
      await expect(writer.put({
        memoryId: "note-getter-secret",
        value: value as never,
        recordedAt: "2026-08-28T00:00:00.000Z",
      })).rejects.toThrow(/accessor|JSON data/i);
      expect(reads).toBe(0);
      expect(await writer.get("note-getter-secret")).toBeNull();
    } finally {
      writer.close();
    }
  });

  it("does not persist bytes from a later Proxy read instead of the scanned value", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    let reads = 0;
    const value = new Proxy({ text: "safe" }, {
      get(target, property, receiver) {
        if (property === "text") {
          reads += 1;
          return reads <= 2 ? "safe" : "changed-after-scan";
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      await writer.put({
        memoryId: "note-proxy-sequence",
        value: value as never,
        recordedAt: "2026-08-28T00:00:00.000Z",
      });
      expect(reads).toBe(0);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = database.prepare("SELECT value_json FROM memory_records WHERE memory_id = ?").get("note-proxy-sequence") as { value_json: string } | undefined;
        expect(row?.value_json).toBe('{"text":"safe"}');
      } finally {
        database.close();
      }
    } finally {
      writer.close();
    }
  });

  it("returns a detached nested snapshot when the caller mutates its value", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    const value = { nested: { text: "before" }, items: [1, { ok: true }] };

    try {
      const stored = await writer.put({
        memoryId: "note-detached",
        value,
        recordedAt: "2026-08-28T00:00:00.000Z",
      });
      value.nested.text = "after";
      (value.items[1] as { ok: boolean }).ok = false;
      expect(stored.value).toEqual({ nested: { text: "before" }, items: [1, { ok: true }] });
      expect(await writer.get("note-detached")).toMatchObject({ value: { nested: { text: "before" }, items: [1, { ok: true }] } });
    } finally {
      writer.close();
    }
  });

  it("accepts normal nested JSON values", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    const value = { nested: { text: "hello", count: 2 }, items: [true, null, "world"] };

    try {
      await writer.put({
        memoryId: "note-nested",
        value,
        recordedAt: "2026-08-28T00:00:00.000Z",
      });
      expect(await writer.get("note-nested")).toMatchObject({ value });
    } finally {
      writer.close();
    }
  });

  it("rejects a secret-shaped memory ID before persisting it", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    const secretId = "ghp_123456789012345678901234567890";
    try {
      await expect(writer.put({
        memoryId: secretId,
        value: { text: "hello" },
        recordedAt: "2026-08-28T00:00:00.000Z",
      })).rejects.toThrow(/secret/i);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare("SELECT memory_id FROM memory_records WHERE memory_id = ?").get(secretId)).toBeUndefined();
      } finally {
        database.close();
      }
    } finally {
      writer.close();
    }
  });

  it("rejects a secret-shaped object key before persisting it", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);

    try {
      await expect(writer.put({
        memoryId: "note-secret-key",
        value: { ghp_123456789012345678901234567890: "hello" },
        recordedAt: "2026-08-28T00:00:00.000Z",
      })).rejects.toThrow(/secret/i);
      expect(await writer.get("note-secret-key")).toBeNull();
    } finally {
      writer.close();
    }
  });

  it("rejects non-plain objects instead of silently changing their value", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);

    await expect(writer.put({
      memoryId: "note-date",
      value: new Date("2026-08-28T00:00:00.000Z") as never,
      recordedAt: "2026-08-28T00:00:00.000Z",
    })).rejects.toThrow(/JSON data/i);
    expect(await writer.get("note-date")).toBeNull();
    writer.close();
  });

  it("rejects a record whose stored value no longer matches its hash", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    await writer.put({
      memoryId: "note-1",
      value: { text: "hello" },
      recordedAt: "2026-08-28T00:00:00.000Z",
    });
    writer.close();

    const tamper = new DatabaseSync(databasePath);
    tamper.prepare("UPDATE memory_records SET value_json = ? WHERE scope_id = ? AND memory_id = ?")
      .run('{"text":"changed"}', "d-ai-hub", "note-1");
    tamper.close();

    const reopened = createWriter(databasePath);
    await expect(reopened.get("note-1")).rejects.toThrow(/integrity/i);
    reopened.close();
  });

  it("rejects a secret-shaped record even when its stored hash matches", async () => {
    const databasePath = await createDatabasePath();
    const writer = createWriter(databasePath);
    await writer.put({
      memoryId: "note-1",
      value: { text: "hello" },
      recordedAt: "2026-08-28T00:00:00.000Z",
    });
    writer.close();

    const secretJson = '{"token":"ghp_123456789012345678901234567890"}';
    const tamper = new DatabaseSync(databasePath);
    tamper.prepare("UPDATE memory_records SET value_json = ?, value_sha256 = ? WHERE scope_id = ? AND memory_id = ?")
      .run(secretJson, createHash("sha256").update(secretJson, "utf8").digest("hex"), "d-ai-hub", "note-1");
    tamper.close();

    const reopened = createWriter(databasePath);
    try {
      await expect(reopened.get("note-1")).rejects.toThrow(/secret/i);
    } finally {
      reopened.close();
    }
  });

  it("persists the resolved workspace binding and rejects a different workspace", async () => {
    const databasePath = await createDatabasePath();
    const root = join(databasePath, "..");
    const firstWorkspace = join(root, "workspace-first");
    const secondWorkspace = join(root, "workspace-second");
    await mkdir(firstWorkspace);
    await mkdir(secondWorkspace);
    const writer = new LocalSqliteMemoryStore({
      databasePath,
      workspacePath: firstWorkspace,
      mode: "writer",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    } as never);
    writer.close();

    let mismatched: LocalSqliteMemoryStore | undefined;
    try {
      expect(() => {
        mismatched = new LocalSqliteMemoryStore({
          databasePath,
          workspacePath: secondWorkspace,
          mode: "writer",
          scopeId: "d-ai-hub",
          writerId: "primary-device",
        } as never);
      }).toThrow(/workspace/i);
    } finally {
      mismatched?.close();
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const scope = database.prepare("SELECT workspace_path FROM memory_scopes WHERE scope_id = ?").get("d-ai-hub") as { workspace_path: string } | undefined;
      expect(scope?.workspace_path).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("accepts a workspace alias that resolves to the persisted workspace", async () => {
    const databasePath = await createDatabasePath();
    const root = join(databasePath, "..");
    const workspace = join(root, "workspace-real");
    const workspaceAlias = join(root, "workspace-alias");
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
    const writer = new LocalSqliteMemoryStore({
      databasePath,
      workspacePath: workspace,
      mode: "writer",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    } as never);
    writer.close();

    const reopened = new LocalSqliteMemoryStore({
      databasePath,
      workspacePath: workspaceAlias,
      mode: "writer",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    } as never);
    reopened.close();
  });

  it("rolls back writer schema creation when workspace registration fails", async () => {
    const databasePath = await createDatabasePath();
    const workspace = join(databasePath, "..");
    const original = new DatabaseSync(databasePath);
    original.exec(`
      CREATE TABLE memory_scopes (
        scope_id TEXT PRIMARY KEY,
        writer_id TEXT NOT NULL CHECK (writer_id = 'secondary-device'),
        workspace_path TEXT NOT NULL
      ) STRICT;
    `);
    original.close();
    const before = await readFile(databasePath);

    expect(() => new LocalSqliteMemoryStore({
      databasePath,
      workspacePath: workspace,
      mode: "writer",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    })).toThrow();
    const after = await readFile(databasePath);
    expect(after).toEqual(before);
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(verify.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'memory_%' OR name = 'applied_bundles' ORDER BY name").all())
        .toEqual([{ type: "table", name: "memory_scopes" }]);
    } finally {
      verify.close();
    }
  });
});
