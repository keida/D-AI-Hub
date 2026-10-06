import { lstat, open, readFile } from "node:fs/promises";
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

export async function readCurationSourceWindow(path: string): Promise<unknown> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("Curation source-window path must be absolute");
  const maxBytes = 1024 * 1024;
  let fileInfo;
  try {
    fileInfo = await lstat(path);
  } catch {
    throw new Error("Curation source-window is not readable");
  }
  if (!fileInfo.isFile()) throw new Error("Curation source-window is not a readable file");
  if (fileInfo.size > maxBytes) throw new Error("Curation source-window exceeds the 1 MiB limit");
  const buffer = Buffer.alloc(maxBytes + 1);
  let length = 0;
  try {
    const file = await open(path, "r");
    try {
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
    } finally {
      await file.close();
    }
  } catch {
    throw new Error("Curation source-window is not readable");
  }
  if (length > maxBytes) throw new Error("Curation source-window exceeds the 1 MiB limit");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
  } catch {
    throw new Error("Curation source-window is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Curation source-window is not valid JSON");
  }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || parsed.version !== 1 || !Object.hasOwn(parsed, "sourceWindow")) {
    throw new Error("Curation source-window envelope is invalid");
  }
  return parsed.sourceWindow;
}
