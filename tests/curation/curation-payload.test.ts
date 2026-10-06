import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCurationPayloadText, readCurationPayload, readCurationSourceWindow } from "../../src/curation/curation-payload.js";

describe("curation payload seam", () => {
  it("passes source-window JSON unchanged for authoritative runtime validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-source-window-file-"));
    try {
      const path = join(root, "window.json");
      const input = { sourceType: "conversation", sourceKey: "selected-window", messages: [{ marker: "m-001", text: "Selected fact." }] };
      await writeFile(path, JSON.stringify({ version: 1, sourceWindow: input }), "utf8");
      await expect(readCurationSourceWindow(path)).resolves.toEqual(input);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts exactly 1 MiB and rejects a larger source-window file", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-source-window-size-"));
    try {
      const path = join(root, "window.json");
      const text = JSON.stringify({ version: 1, sourceWindow: {} });
      await writeFile(path, text.padEnd(1024 * 1024, " "));
      await expect(readCurationSourceWindow(path)).resolves.toEqual({});
      await writeFile(path, text.padEnd(1024 * 1024 + 1, " "));
      await expect(readCurationSourceWindow(path)).rejects.toThrow(/1 MiB/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { bytes: Buffer.from([0xc3, 0x28]), reason: /UTF-8/ },
    { bytes: Buffer.from("{private-input-content"), reason: /JSON/ },
    { bytes: Buffer.from('{"version":2,"sourceWindow":{}}'), reason: /envelope/ },
    { bytes: Buffer.from('{"version":1}'), reason: /envelope/ },
    { bytes: Buffer.from('{"version":1,"sourceWindow":{},"extra":true}'), reason: /envelope/ },
  ])("rejects malformed source-window bytes or envelopes ($reason)", async ({ bytes, reason }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-source-window-invalid-"));
    try {
      const path = join(root, "window.json");
      await writeFile(path, bytes);
      await expect(readCurationSourceWindow(path)).rejects.toThrow(reason);
      await expect(readCurationSourceWindow(path)).rejects.not.toThrow(/private-input-content/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an absolute regular source-window file", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-source-window-path-"));
    try {
      await expect(readCurationSourceWindow("relative.json")).rejects.toThrow(/absolute/);
      await expect(readCurationSourceWindow(join(root, "missing.json"))).rejects.toThrow(/readable/);
      await expect(readCurationSourceWindow(root)).rejects.toThrow(/readable file/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only the versioned structured current-context shape", () => {
    expect(parseCurationPayloadText(JSON.stringify({
      version: 1,
      candidates: [{
        candidateId: "payload-fact",
        memoryId: "payload-fact",
        fact: "Structured facts stay local.",
        category: "knowledge",
        source: "current-context",
        privacyRisk: "local-private",
      }],
    }))).toMatchObject({ version: 1, candidates: [{ memoryId: "payload-fact" }] });
  });

  it.each<[string, RegExp]>([
    ["not-json", /not valid JSON/i],
    [JSON.stringify({ version: 2, candidates: [] }), /structure is invalid/i],
    [JSON.stringify({ version: 1, candidates: [{ memoryId: "bad", fact: "not enough" }] }), /candidate/i],
  ])("rejects malformed payloads without exposing content", (text, expected) => {
    expect(() => parseCurationPayloadText(text)).toThrow(expected);
    try {
      parseCurationPayloadText(text);
      throw new Error("expected payload parsing to fail");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("not enough");
      expect((error as Error).message).not.toContain("bad");
    }
  });

  it("requires an absolute readable file", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-curation-payload-"));
    const path = join(root, "payload.json");
    try {
      await expect(readCurationPayload("relative-payload.json")).rejects.toThrow(/absolute/i);
      await expect(readCurationPayload(path)).rejects.toThrow(/readable/i);
      await writeFile(path, JSON.stringify({ version: 1, candidates: [] }), "utf8");
      await expect(readCurationPayload(path)).resolves.toMatchObject({ version: 1, candidates: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
