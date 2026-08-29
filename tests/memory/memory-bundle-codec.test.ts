import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { linkSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { exportMemoryBundle, importMemoryBundle } from "../../src/memory/memory-bundle-codec.js";
import { cleanupReaderInitializationArtifacts, LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";

const temporaryRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-memory-bundle-"));
  temporaryRoots.push(root);
  return root;
}

function createStore(databasePath: string, mode: "reader" | "writer"): LocalSqliteMemoryStore {
  return new LocalSqliteMemoryStore({
    databasePath,
    workspacePath: join(databasePath, ".."),
    mode,
    scopeId: "d-ai-hub",
    writerId: "primary-device",
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("memory bundle codec", () => {
  it("exports ordered records and imports them into a separate reader database", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    await writer.put({ memoryId: "note-2", value: { text: "world" }, recordedAt: "2026-08-28T00:01:00.000Z" });

    const bundleDirectory = join(root, "bundle-1");
    const bundle = await exportMemoryBundle(writer, bundleDirectory, {
      bundleId: "bundle-1",
      createdAt: "2026-08-28T00:02:00.000Z",
    });
    expect(bundle.manifest).toMatchObject({
      formatVersion: 1,
      bundleId: "bundle-1",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
      fromSequence: 1,
      toSequence: 2,
      recordCount: 2,
    });
    expect((await readFile(join(bundleDirectory, "records.jsonl"), "utf8")).split("\n")).toHaveLength(3);
    expect(bundle.recordsJsonl).not.toContain("workspacePath");
    expect(await readFile(join(bundleDirectory, "manifest.json"), "utf8")).not.toContain("workspacePath");

    writer.close();
    const reader = createStore(join(root, "reader.sqlite"), "writer");
    reader.close();
    const readOnlyReader = createStore(join(root, "reader.sqlite"), "reader");
    expect(await importMemoryBundle(readOnlyReader, bundleDirectory)).toMatchObject({ outcome: "IMPORTED", bundleId: "bundle-1" });
    expect(await readOnlyReader.get("note-1")).toMatchObject({ memoryId: "note-1", value: { text: "hello" }, sequence: 1 });
    expect(await readOnlyReader.get("note-2")).toMatchObject({ memoryId: "note-2", value: { text: "world" }, sequence: 2 });
    readOnlyReader.close();
  });

  it("blocks an incremental bundle that starts after sequence 1 before initializing a missing reader", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "first" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    await writer.put({ memoryId: "note-2", value: { text: "second" }, recordedAt: "2026-08-28T00:01:00.000Z" });
    const bundleDirectory = join(root, "bundle-gap-fresh");
    await exportMemoryBundle(writer, bundleDirectory, {
      bundleId: "bundle-gap-fresh",
      createdAt: "2026-08-28T00:02:00.000Z",
      afterSequence: 1,
    });
    writer.close();

    const readerPath = join(root, "missing-reader.sqlite");
    const result = await importMemoryBundle({
      databasePath: readerPath,
      workspacePath: root,
      mode: "reader",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    }, bundleDirectory);

    expect(result).toMatchObject({ outcome: "BLOCKED", importedCount: 0 });
    expect(result.reason).toMatch(/sequence 1/i);
    await expect(access(readerPath)).rejects.toThrow();
  });

  it("blocks a gap after the reader's current sequence without inserting records or a receipt", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "first" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const firstBundleDirectory = join(root, "bundle-first");
    await exportMemoryBundle(writer, firstBundleDirectory, {
      bundleId: "bundle-first",
      createdAt: "2026-08-28T00:01:00.000Z",
    });
    await writer.put({ memoryId: "note-2", value: { text: "second" }, recordedAt: "2026-08-28T00:02:00.000Z" });
    await writer.put({ memoryId: "note-3", value: { text: "third" }, recordedAt: "2026-08-28T00:03:00.000Z" });
    const gapBundleDirectory = join(root, "bundle-gap-existing");
    await exportMemoryBundle(writer, gapBundleDirectory, {
      bundleId: "bundle-gap-existing",
      createdAt: "2026-08-28T00:04:00.000Z",
      afterSequence: 2,
    });
    writer.close();

    const readerPath = join(root, "reader.sqlite");
    const readerOptions = {
      databasePath: readerPath,
      workspacePath: root,
      mode: "reader" as const,
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    };
    expect(await importMemoryBundle(readerOptions, firstBundleDirectory)).toMatchObject({ outcome: "IMPORTED" });
    const result = await importMemoryBundle(readerOptions, gapBundleDirectory);

    expect(result).toMatchObject({ outcome: "BLOCKED", importedCount: 0 });
    expect(result.reason).toMatch(/sequence 2/i);
    const reader = createStore(readerPath, "reader");
    expect(await reader.get("note-1")).toMatchObject({ sequence: 1 });
    expect(await reader.get("note-3")).toBeNull();
    expect(reader.getAppliedBundleReceipt("bundle-gap-existing")).toBeNull();
    reader.close();
  });

  it("blocks a tampered JSONL bundle without mutating the reader", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-1");
    await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-1", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();
    const recordsPath = join(bundleDirectory, "records.jsonl");
    const records = await readFile(recordsPath, "utf8");
    await writeFile(recordsPath, records.replace("hello", "tampered"), "utf8");
    const reader = createStore(join(root, "reader.sqlite"), "writer");
    reader.close();
    const readOnlyReader = createStore(join(root, "reader.sqlite"), "reader");
    expect(await importMemoryBundle(readOnlyReader, bundleDirectory)).toMatchObject({ outcome: "BLOCKED" });
    expect(await readOnlyReader.get("note-1")).toBeNull();
    readOnlyReader.close();
  });

  it("blocks invalid UTF-8 bytes that would decode to the same U+FFFD text", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-invalid-utf8", value: { text: "\uFFFD" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-invalid-utf8");
    await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-invalid-utf8", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();

    const recordsPath = join(bundleDirectory, "records.jsonl");
    const original = await readFile(recordsPath);
    const replacementBytes = Buffer.from("\uFFFD", "utf8");
    const replacementIndex = original.indexOf(replacementBytes);
    expect(replacementIndex).toBeGreaterThanOrEqual(0);
    const invalid = Buffer.concat([
      original.subarray(0, replacementIndex),
      Buffer.from([0xff]),
      original.subarray(replacementIndex + replacementBytes.length),
    ]);
    await writeFile(recordsPath, invalid);

    const readerPath = join(root, "reader.sqlite");
    const receipt = await importMemoryBundle({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" }, bundleDirectory);
    expect(receipt).toMatchObject({ outcome: "BLOCKED" });
    expect(receipt.reason).toMatch(/UTF-8/i);
    await expect(access(readerPath)).rejects.toThrow();
  });

  it("returns NOOP_DUPLICATE for an unchanged repeat and blocks a reused ID with another digest", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const firstDirectory = join(root, "bundle-1");
    await exportMemoryBundle(writer, firstDirectory, { bundleId: "bundle-1", createdAt: "2026-08-28T00:02:00.000Z" });
    const secondDirectory = join(root, "bundle-1-reused");
    await exportMemoryBundle(writer, secondDirectory, { bundleId: "bundle-1", createdAt: "2026-08-28T00:03:00.000Z" });
    writer.close();
    const reader = createStore(join(root, "reader.sqlite"), "writer");
    reader.close();
    const readOnlyReader = createStore(join(root, "reader.sqlite"), "reader");
    expect(await importMemoryBundle(readOnlyReader, firstDirectory)).toMatchObject({ outcome: "IMPORTED" });
    expect(await importMemoryBundle(readOnlyReader, firstDirectory)).toMatchObject({ outcome: "NOOP_DUPLICATE" });
    const secondRecordsPath = join(secondDirectory, "records.jsonl");
    const secondRecord = JSON.parse((await readFile(secondRecordsPath, "utf8")).trim()) as { value: { text: string }; valueSha256: string };
    secondRecord.value.text = "other";
    secondRecord.valueSha256 = sha256(JSON.stringify(secondRecord.value));
    const secondRecords = `${JSON.stringify(secondRecord)}\n`;
    await writeFile(secondRecordsPath, secondRecords, "utf8");
    const secondManifestPath = join(secondDirectory, "manifest.json");
    const secondManifest = JSON.parse(await readFile(secondManifestPath, "utf8")) as { recordsSha256: string };
    secondManifest.recordsSha256 = sha256(secondRecords);
    await writeFile(secondManifestPath, `${JSON.stringify(secondManifest, null, 2)}\n`, "utf8");
    expect(await importMemoryBundle(readOnlyReader, secondDirectory)).toMatchObject({ outcome: "BLOCKED" });
    expect(await readOnlyReader.get("note-1")).toMatchObject({ value: { text: "hello" } });
    readOnlyReader.close();
  });

  it("blocks secret-shaped JSONL without mutating the reader", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-secret");
    await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-secret", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();
    const recordsPath = join(bundleDirectory, "records.jsonl");
    const record = JSON.parse((await readFile(recordsPath, "utf8")).trim()) as { value: { text: string }; valueSha256: string };
    record.value.text = "ghp_123456789012345678901234567890";
    record.valueSha256 = sha256(JSON.stringify(record.value));
    const records = `${JSON.stringify(record)}\n`;
    await writeFile(recordsPath, records, "utf8");
    const manifestPath = join(bundleDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { recordsSha256: string };
    manifest.recordsSha256 = sha256(records);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const reader = createStore(join(root, "reader.sqlite"), "writer");
    reader.close();
    const readOnlyReader = createStore(join(root, "reader.sqlite"), "reader");
    expect(await importMemoryBundle(readOnlyReader, bundleDirectory)).toMatchObject({ outcome: "BLOCKED" });
    expect(await readOnlyReader.get("note-1")).toBeNull();
    readOnlyReader.close();
  });

  it("rejects a secret-shaped bundle ID before creating bundle files", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "secret-bundle");

    try {
      await expect(exportMemoryBundle(writer, bundleDirectory, {
        bundleId: "ghp_123456789012345678901234567890",
        createdAt: "2026-08-28T00:02:00.000Z",
      })).rejects.toThrow(/secret/i);
      await expect(access(bundleDirectory)).rejects.toThrow();
    } finally {
      writer.close();
    }
  });

  it.each([
    ["secret-shaped value", (record: Record<string, unknown>) => ({ ...record, value: { token: "ghp_123456789012345678901234567890" } })],
    ["wrong scope", (record: Record<string, unknown>) => ({ ...record, scopeId: "other-scope" })],
    ["wrong writer", (record: Record<string, unknown>) => ({ ...record, writerId: "secondary-device" })],
    ["wrong value hash", (record: Record<string, unknown>) => ({ ...record, valueSha256: "0".repeat(64) })],
    ["non-ISO timestamp", (record: Record<string, unknown>) => ({ ...record, recordedAt: "2026-08-28" })],
    ["invalid sequence", (record: Record<string, unknown>) => ({ ...record, sequence: 0 })],
  ])("does not allow the public import seam to bypass validation: %s", async (label, mutate) => {
    const root = await createRoot();
    const databasePath = join(root, `${String(label).replaceAll(" ", "-")}.sqlite`);
    const writer = createStore(databasePath, "writer");
    const original = await writer.put({ memoryId: "direct-note", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    writer.close();
    const candidate = mutate({ ...original }) as Record<string, unknown>;
    const recordsJsonl = `${canonicalJson(candidate)}\n`;
    const reader = createStore(databasePath, "reader");
    expect(() => reader.applyImportedBundle({
      bundleId: "direct-bypass",
      recordsSha256: sha256(recordsJsonl),
      records: [candidate],
      recordsBytes: Buffer.from(recordsJsonl, "utf8"),
      appliedAt: "2026-08-28T00:02:00.000Z",
    } as never)).toThrow();
    expect(await reader.get("direct-note")).toMatchObject({ value: { text: "hello" } });
    reader.close();
  });

  it("uses one Proxy data-descriptor snapshot for direct import validation and insertion", async () => {
    const root = await createRoot();
    const databasePath = join(root, "direct-proxy.sqlite");
    const writer = createStore(databasePath, "writer");
    writer.close();
    const reader = createStore(databasePath, "reader");
    let reads = 0;
    const value = new Proxy({ text: "safe" }, {
      get(target, property, receiver) {
        if (property === "text") {
          reads += 1;
          return reads <= 5 ? "safe" : "changed-after-validation";
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const record = {
      memoryId: "direct-proxy",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
      sequence: 1,
      value,
      valueSha256: sha256('{"text":"safe"}'),
      recordedAt: "2026-08-28T00:00:00.000Z",
    };
    const recordsJsonl = `${canonicalJson(record)}\n`;

    try {
      const result = reader.applyImportedBundle({
        bundleId: "bundle-direct-proxy",
        recordsSha256: sha256(recordsJsonl),
        records: [record],
        recordsBytes: Buffer.from(recordsJsonl, "utf8"),
        appliedAt: "2026-08-28T00:02:00.000Z",
      });
      expect(result).toMatchObject({ outcome: "IMPORTED", importedCount: 1 });
      expect(reads).toBeLessThanOrEqual(1);
      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = database.prepare("SELECT value_json FROM memory_records WHERE memory_id = ?").get("direct-proxy") as { value_json: string } | undefined;
        expect(row?.value_json).toBe('{"text":"safe"}');
      } finally {
        database.close();
      }
    } finally {
      reader.close();
    }
  });

  it("rejects a second writer identity for the same scope", async () => {
    const root = await createRoot();
    const databasePath = join(root, "writer.sqlite");
    const writer = createStore(databasePath, "writer");
    writer.close();
    expect(() => new LocalSqliteMemoryStore({ databasePath, workspacePath: root, mode: "writer", scopeId: "d-ai-hub", writerId: "secondary-device" })).toThrow(/writer/i);
  });

  it("blocks import when the persisted scope owner changes before the transaction", async () => {
    const root = await createRoot();
    const databasePath = join(root, "owner-changed.sqlite");
    const writer = createStore(databasePath, "writer");
    writer.close();
    const reader = createStore(databasePath, "reader");
    const tamper = new DatabaseSync(databasePath);
    tamper.prepare("UPDATE memory_scopes SET writer_id = ? WHERE scope_id = ?").run("secondary-device", "d-ai-hub");
    tamper.close();
    const value = { text: "hello" };
    const record = {
      memoryId: "note-owner-check",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
      sequence: 1,
      value,
      valueSha256: sha256(canonicalJson(value)),
      recordedAt: "2026-08-28T00:00:00.000Z",
    };
    const recordsJsonl = `${canonicalJson(record)}\n`;

    try {
      const result = reader.applyImportedBundle({
        bundleId: "bundle-owner-check",
        recordsSha256: sha256(recordsJsonl),
        records: [record],
        recordsBytes: Buffer.from(recordsJsonl, "utf8"),
        appliedAt: "2026-08-28T00:02:00.000Z",
      });
      expect(result).toMatchObject({ outcome: "BLOCKED", importedCount: 0 });
      expect(result.reason).toMatch(/writer|owner/i);
      expect(await reader.get("note-owner-check")).toBeNull();
      expect(reader.getAppliedBundleReceipt("bundle-owner-check")).toBeNull();
    } finally {
      reader.close();
    }
  });

  it("blocks the direct apply seam on a writer store without mutation", async () => {
    const root = await createRoot();
    const databasePath = join(root, "writer-direct-import.sqlite");
    const writer = createStore(databasePath, "writer");
    const value = { text: "hello" };
    const record = {
      memoryId: "note-writer-direct",
      scopeId: "d-ai-hub",
      writerId: "primary-device",
      sequence: 1,
      value,
      valueSha256: sha256(canonicalJson(value)),
      recordedAt: "2026-08-28T00:00:00.000Z",
    };
    const recordsJsonl = `${canonicalJson(record)}\n`;

    try {
      const result = writer.applyImportedBundle({
        bundleId: "bundle-writer-direct",
        recordsSha256: sha256(recordsJsonl),
        records: [record],
        recordsBytes: Buffer.from(recordsJsonl, "utf8"),
        appliedAt: "2026-08-28T00:02:00.000Z",
      });
      expect(result).toMatchObject({ outcome: "BLOCKED", importedCount: 0 });
      expect(result.reason).toMatch(/reader mode/i);
      expect(await writer.get("note-writer-direct")).toBeNull();
      expect(writer.getAppliedBundleReceipt("bundle-writer-direct")).toBeNull();
    } finally {
      writer.close();
    }
  });

  it("blocks codec import through a writer store instance", async () => {
    const root = await createRoot();
    const source = createStore(join(root, "source.sqlite"), "writer");
    await source.put({ memoryId: "note-writer-codec", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-writer-codec");
    await exportMemoryBundle(source, bundleDirectory, { bundleId: "bundle-writer-codec", createdAt: "2026-08-28T00:02:00.000Z" });
    source.close();
    const target = createStore(join(root, "target.sqlite"), "writer");
    try {
      const receipt = await importMemoryBundle(target, bundleDirectory);
      expect(receipt).toMatchObject({ outcome: "BLOCKED", importedCount: 0 });
      expect(receipt.reason).toMatch(/reader mode/i);
      expect(await target.get("note-writer-codec")).toBeNull();
    } finally {
      target.close();
    }
  });

  it.each(["writer", "invalid"])("blocks codec option import with runtime mode %s before database creation", async (mode) => {
    const root = await createRoot();
    const source = createStore(join(root, `source-${mode}.sqlite`), "writer");
    await source.put({ memoryId: `note-${mode}-options`, value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, `bundle-${mode}-options`);
    await exportMemoryBundle(source, bundleDirectory, { bundleId: `bundle-${mode}-options`, createdAt: "2026-08-28T00:02:00.000Z" });
    source.close();
    const targetPath = join(root, `target-${mode}.sqlite`);

    const receipt = await importMemoryBundle({
      databasePath: targetPath,
      workspacePath: root,
      mode: mode as never,
      scopeId: "d-ai-hub",
      writerId: "primary-device",
    }, bundleDirectory);
    expect(receipt).toMatchObject({ outcome: "BLOCKED", importedCount: 0 });
    expect(receipt.reason).toMatch(/reader mode/i);
    await expect(access(targetPath)).rejects.toThrow();
  });

  it("blocks non-canonical JSONL even when its digest is updated", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-noncanonical");
    await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-noncanonical", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();
    const recordsPath = join(bundleDirectory, "records.jsonl");
    const original = JSON.parse((await readFile(recordsPath, "utf8")).trim()) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(original).reverse());
    const recordsJsonl = `${JSON.stringify(reordered)}\n`;
    await writeFile(recordsPath, recordsJsonl, "utf8");
    const manifestPath = join(bundleDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { recordsSha256: string };
    manifest.recordsSha256 = sha256(recordsJsonl);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const reader = createStore(join(root, "reader.sqlite"), "writer");
    reader.close();
    const readOnlyReader = createStore(join(root, "reader.sqlite"), "reader");
    expect(await importMemoryBundle(readOnlyReader, bundleDirectory)).toMatchObject({ outcome: "BLOCKED" });
    expect(await readOnlyReader.get("note-1")).toBeNull();
    readOnlyReader.close();
  });

  it("rejects non-ISO timestamps and unsafe applied-bundle identifiers", async () => {
    const root = await createRoot();
    const databasePath = join(root, "writer.sqlite");
    const writer = createStore(databasePath, "writer");
    await expect(writer.put({ memoryId: "bad-time", value: { text: "hello" }, recordedAt: "2026-08-28" })).rejects.toThrow(/ISO/i);
    writer.close();
    const reader = createStore(databasePath, "reader");
    expect(() => reader.getAppliedBundleReceipt("../unsafe")).toThrow(/safe/i);
    reader.close();
  });

  it("returns BLOCKED and leaves no partial records or receipt when SQLite rejects an insert", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "note-1", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    await writer.put({ memoryId: "note-2", value: { text: "world" }, recordedAt: "2026-08-28T00:01:00.000Z" });
    const bundleDirectory = join(root, "bundle-trigger");
    const bundle = await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-trigger", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();
    const reader = createStore(join(root, "reader.sqlite"), "writer");
    reader.close();
    const triggerDb = new DatabaseSync(join(root, "reader.sqlite"));
    triggerDb.exec("CREATE TRIGGER reject_second BEFORE INSERT ON memory_records WHEN NEW.memory_id = 'note-2' BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;");
    triggerDb.close();
    const readOnlyReader = createStore(join(root, "reader.sqlite"), "reader");
    const result = readOnlyReader.applyImportedBundle({
      bundleId: bundle.manifest.bundleId,
      recordsSha256: bundle.manifest.recordsSha256,
      records: bundle.records,
      recordsBytes: Buffer.from(bundle.recordsJsonl, "utf8"),
      appliedAt: bundle.manifest.createdAt,
    });
    expect(result.outcome).toBe("BLOCKED");
    expect(await readOnlyReader.get("note-1")).toBeNull();
    expect(await readOnlyReader.get("note-2")).toBeNull();
    expect(readOnlyReader.getAppliedBundleReceipt("bundle-trigger")).toBeNull();
    readOnlyReader.close();
  });

  it.each([
    ["bundleId", " bundle-padded ", "note-padded"],
    ["memoryId", "bundle-padded", " note-padded "],
  ])("rejects whitespace-padded direct seam %s without database mutation", async (field, bundleId, memoryId) => {
    const root = await createRoot();
    const databasePath = join(root, `${field}-padding.sqlite`);
    const writer = createStore(databasePath, "writer");
    writer.close();
    const reader = createStore(databasePath, "reader");
    const record = {
      memoryId,
      scopeId: "d-ai-hub",
      writerId: "primary-device",
      sequence: 1,
      value: { text: "hello" },
      valueSha256: sha256(canonicalJson({ text: "hello" })),
      recordedAt: "2026-08-28T00:00:00.000Z",
    };
    const recordsJsonl = `${canonicalJson(record)}\n`;
    try {
      expect(() => reader.applyImportedBundle({
        bundleId,
        recordsSha256: sha256(recordsJsonl),
        records: [record],
        recordsBytes: Buffer.from(recordsJsonl, "utf8"),
        appliedAt: "2026-08-28T00:02:00.000Z",
      } as never)).toThrow(/safe|whitespace|identifier/i);
      expect(await reader.get("note-padded")).toBeNull();
      expect(reader.getAppliedBundleReceipt("bundle-padded")).toBeNull();
    } finally {
      reader.close();
    }
  });

  it("validates first, initializes a missing reader database, and preserves the imported ID after reopen", async () => {
    const root = await createRoot();
    const writerPath = join(root, "writer.sqlite");
    const writer = createStore(writerPath, "writer");
    await writer.put({ memoryId: "fresh-note", value: { text: "fresh" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-fresh");
    await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-fresh", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();
    const readerPath = join(root, "fresh-reader.sqlite");
    await expect(access(readerPath)).rejects.toThrow();
    const receipt = await importMemoryBundle({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" }, bundleDirectory);
    expect(receipt).toMatchObject({ outcome: "IMPORTED", bundleId: "bundle-fresh" });
    const reader = createStore(readerPath, "reader");
    expect(await reader.get("fresh-note")).toMatchObject({ memoryId: "fresh-note", value: { text: "fresh" } });
    reader.close();
    const reopened = createStore(readerPath, "reader");
    expect(await reopened.get("fresh-note")).toMatchObject({ memoryId: "fresh-note" });
    reopened.close();
  });

  it("does not create a missing reader database for a tampered bundle", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "tampered-note", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-tampered-missing");
    await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-tampered-missing", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();
    const recordsPath = join(bundleDirectory, "records.jsonl");
    await writeFile(recordsPath, (await readFile(recordsPath, "utf8")).replace("hello", "tampered"), "utf8");
    const readerPath = join(root, "missing-reader.sqlite");
    const receipt = await importMemoryBundle({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" }, bundleDirectory);
    expect(receipt.outcome).toBe("BLOCKED");
    await expect(access(readerPath)).rejects.toThrow();
  });

  it("does not mutate a pre-existing zero-byte reader file for a tampered bundle", async () => {
    const root = await createRoot();
    const writer = createStore(join(root, "writer.sqlite"), "writer");
    await writer.put({ memoryId: "tampered-empty", value: { text: "hello" }, recordedAt: "2026-08-28T00:00:00.000Z" });
    const bundleDirectory = join(root, "bundle-tampered-empty");
    await exportMemoryBundle(writer, bundleDirectory, { bundleId: "bundle-tampered-empty", createdAt: "2026-08-28T00:02:00.000Z" });
    writer.close();
    const recordsPath = join(bundleDirectory, "records.jsonl");
    await writeFile(recordsPath, (await readFile(recordsPath, "utf8")).replace("hello", "tampered"), "utf8");
    const readerPath = join(root, "empty-reader.sqlite");
    await writeFile(readerPath, "", "utf8");
    const before = await readFile(readerPath);
    const receipt = await importMemoryBundle({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" }, bundleDirectory);
    expect(receipt.outcome).toBe("BLOCKED");
    expect(await readFile(readerPath)).toEqual(before);
  });

  it("does not leave a database or temporary artifacts when reader initialization fails before opening", async () => {
    const root = await createRoot();
    const readerPath = join(root, "missing-parent", "reader.sqlite");
    expect(() => LocalSqliteMemoryStore.initializeReaderDatabase({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" })).toThrow();
    await expect(access(readerPath)).rejects.toThrow();
    await expect(access(join(root, "missing-parent"))).rejects.toThrow();
  });

  it("rolls back all schema DDL when reader initialization fails against an existing target", async () => {
    const root = await createRoot();
    const readerPath = join(root, "conflicting-reader.sqlite");
    const originalDb = new DatabaseSync(readerPath);
    originalDb.exec("CREATE VIEW memory_scopes AS SELECT 'existing' AS writer_id;");
    originalDb.close();
    const before = await readFile(readerPath);
    expect(() => LocalSqliteMemoryStore.initializeReaderDatabase({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" })).toThrow();
    expect(await readFile(readerPath)).toEqual(before);
    const verifyDb = new DatabaseSync(readerPath, { readOnly: true });
    const objects = verifyDb.prepare("SELECT type, name FROM sqlite_master WHERE name IN ('memory_records', 'applied_bundles', 'memory_scopes') ORDER BY name").all() as Array<{ type: string; name: string }>;
    expect(objects).toEqual([{ type: "view", name: "memory_scopes" }]);
    verifyDb.close();
  });

  it("rejects an existing reader database with incorrect columns without changing it", async () => {
    const root = await createRoot();
    const readerPath = join(root, "wrong-columns.sqlite");
    const originalDb = new DatabaseSync(readerPath);
    originalDb.exec("CREATE TABLE memory_records (wrong TEXT); CREATE TABLE applied_bundles (wrong TEXT); CREATE TABLE memory_scopes (wrong TEXT);");
    originalDb.close();
    const before = await readFile(readerPath);
    expect(() => LocalSqliteMemoryStore.initializeReaderDatabase({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" })).toThrow(/schema|initialized|column/i);
    expect(await readFile(readerPath)).toEqual(before);
    const verifyDb = new DatabaseSync(readerPath, { readOnly: true });
    expect((verifyDb.prepare("PRAGMA table_info(memory_records)").all() as Array<{ name: string }>).map((column) => column.name)).toEqual(["wrong"]);
    verifyDb.close();
  });

  it("rejects non-STRICT tables whose stored SQL only contains a STRICT token", async () => {
    const root = await createRoot();
    const readerPath = join(root, "strict-token-only.sqlite");
    const originalDb = new DatabaseSync(readerPath);
    originalDb.exec(`
      CREATE TABLE memory_records /* STRICT compatibility token */ (
        scope_id TEXT NOT NULL,
        memory_id TEXT NOT NULL,
        writer_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        value_json TEXT NOT NULL,
        value_sha256 TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (scope_id, memory_id),
        UNIQUE (scope_id, writer_id, sequence)
      );
      CREATE TABLE applied_bundles /* STRICT compatibility token */ (
        scope_id TEXT NOT NULL,
        bundle_id TEXT NOT NULL,
        records_sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY (scope_id, bundle_id)
      );
      CREATE TABLE memory_scopes /* STRICT compatibility token */ (
        scope_id TEXT NOT NULL PRIMARY KEY,
        writer_id TEXT NOT NULL,
        workspace_path TEXT NOT NULL
      );
    `);
    const strictFlags = originalDb.prepare("PRAGMA table_list").all() as Array<{ name: string; strict: number }>;
    expect(strictFlags.filter((table) => ["memory_records", "applied_bundles", "memory_scopes"].includes(table.name)).map((table) => table.strict)).toEqual([0, 0, 0]);
    originalDb.close();
    const before = await readFile(readerPath);

    expect(() => LocalSqliteMemoryStore.initializeReaderDatabase({ databasePath: readerPath, workspacePath: root, mode: "reader", scopeId: "d-ai-hub", writerId: "primary-device" })).toThrow(/schema|initialized|strict/i);
    expect(await readFile(readerPath)).toEqual(before);
  });

  it("post-publish cleanup removes only the unique temporary artifacts and preserves a replacement target", async () => {
    const root = await createRoot();
    const readerPath = join(root, "reader.sqlite");
    const temporaryPath = join(root, "reader.sqlite.tmp-unique");
    const artifacts = [temporaryPath, `${temporaryPath}-journal`, `${temporaryPath}-wal`, `${temporaryPath}-shm`];
    await Promise.all(artifacts.map((path) => writeFile(path, "artifact", "utf8")));
    linkSync(temporaryPath, readerPath);
    rmSync(readerPath);
    await writeFile(readerPath, "replacement", "utf8");
    const originalError = new Error("initialization failed");
    const returned = cleanupReaderInitializationArtifacts(temporaryPath, originalError, (path) => {
      const first = path === artifacts[0];
      rmSync(path, { force: true, recursive: true });
      if (first) throw new Error("cleanup failed");
    });
    expect(returned).toBe(originalError);
    await Promise.all(artifacts.map(async (path) => expect(access(path)).rejects.toThrow()));
    expect(await readFile(readerPath, "utf8")).toBe("replacement");
  });

});
