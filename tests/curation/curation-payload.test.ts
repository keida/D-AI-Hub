import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCurationPayloadText, readCurationPayload } from "../../src/curation/curation-payload.js";

describe("curation payload seam", () => {
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
