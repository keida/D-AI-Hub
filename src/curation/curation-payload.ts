import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { assertCurationCandidate, type CurationCandidate } from "./local-curation.js";

export interface CurationPayload {
  readonly version: 1;
  readonly candidates: readonly CurationCandidate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPayload(): never {
  throw new Error("Curation payload structure is invalid");
}

export function parseCurationPayloadText(text: string): CurationPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Curation payload is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.candidates)) invalidPayload();
  const candidates = parsed.candidates.map((candidate) => {
    if (!isRecord(candidate)) invalidPayload();
    const value = candidate as unknown as CurationCandidate;
    assertCurationCandidate(value);
    return value;
  });
  return { version: 1, candidates };
}

export async function readCurationPayload(path: string): Promise<CurationPayload> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Curation payload path must be absolute");
  let file;
  try {
    file = await lstat(path);
  } catch {
    throw new Error("Curation payload is not readable");
  }
  if (!file.isFile()) throw new Error("Curation payload is not a readable file");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error("Curation payload is not readable");
  }
  return parseCurationPayloadText(text);
}
