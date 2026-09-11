import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { parseCurationPayloadText } from "../curation/curation-payload.js";
import type {
  CurationCandidate,
  CurationCategory,
  CurationDecision,
  CurationResult,
} from "../curation/local-curation.js";
import { createConfiguredCurationHandler } from "../runtime/d-ai-runtime.js";

export const MAX_CURATE_PAYLOAD_BYTES = 16_384;

const sourceSchema = z.enum(["chatgpt", "codex", "manual"]);
const projectHintSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const curateArgumentsSchema = z.object({
  payload: z.string().min(1).max(MAX_CURATE_PAYLOAD_BYTES),
  source: sourceSchema,
  projectHint: projectHintSchema.optional(),
}).strict();
const allowedPayloadKeys = new Set(["version", "candidates"]);
const allowedCandidateKeys = new Set(["candidateId", "memoryId", "fact", "category", "source", "privacyRisk", "revision", "projectTaskId"]);

export interface CurateMcpDependencies {
  readonly curate: (candidates: readonly CurationCandidate[], projectHint: string | null) => Promise<CurationResult>;
}

export interface CurateMetadata {
  readonly decision: CurationDecision | "MIXED";
  readonly category?: CurationCategory | "mixed";
  readonly memoryId?: string;
  readonly records?: readonly { readonly decision: CurationDecision; readonly category: CurationCategory; readonly memoryId: string }[];
  readonly persisted: boolean;
  readonly readBackVerified: boolean;
  readonly safeToDeleteSuppliedPayload: "YES" | "NO";
  readonly message: string;
}

const toolDescription = "Persist one bounded, versioned current-context curation payload through Local Curation V1. Plain prose, paths, SQL, commands, unknown fields, workplace-risk facts, and unresolved project hints are rejected or deferred without writes.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeMessage(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 237)}...`;
}

function blockedMetadata(message: string): CurateMetadata {
  return {
    decision: "DEFER",
    persisted: false,
    readBackVerified: false,
    safeToDeleteSuppliedPayload: "NO",
    message: safeMessage(message),
  };
}

function parseStrictPayload(text: string): readonly CurationCandidate[] {
  if (Buffer.byteLength(text, "utf8") > MAX_CURATE_PAYLOAD_BYTES) throw new Error("Payload exceeds the 16 KiB UTF-8 limit");
  if (text.trim().length === 0) throw new Error("Payload must be non-empty");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Payload must be valid JSON");
  }
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, allowedPayloadKeys) || !Array.isArray(parsed.candidates)) {
    throw new Error("Payload must contain only version and candidates");
  }
  for (const candidate of parsed.candidates) {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, allowedCandidateKeys)) throw new Error("Payload candidates contain an unknown field");
  }
  return parseCurationPayloadText(text).candidates;
}

function metadataFromResult(result: CurationResult, transportSource: "chatgpt" | "codex" | "manual"): CurateMetadata {
  const records = result.records.map(({ decision, category, memoryId }) => ({ decision, category, memoryId }));
  const first = records[0];
  const sameDecision = records.every((record) => record.decision === first?.decision);
  const sameCategory = records.every((record) => record.category === first?.category);
  return {
    decision: first !== undefined && sameDecision ? first.decision : result.status === "blocked" ? "DEFER" : "MIXED",
    ...(first !== undefined && sameCategory ? { category: first.category } : records.length > 0 ? { category: "mixed" as const } : {}),
    ...(records.length === 1 ? { memoryId: records[0]!.memoryId } : {}),
    ...(records.length === 0 ? {} : { records }),
    persisted: result.locallyStored,
    readBackVerified: result.readBackVerified,
    safeToDeleteSuppliedPayload: result.safeToDeleteOriginalChat,
    message: safeMessage(`Local Curation V1 ${result.status}; added=${result.counts.added}, updated=${result.counts.updated}, no-op=${result.counts.noOp}, deferred=${result.counts.deferred}, rejected=${result.counts.rejected}; transport source=${transportSource} was validated only and is not durable provenance; source payload was not captured${result.locallyStored ? " and selected facts were verified locally" : ""}.`),
  };
}

async function executeCurate(argumentsValue: unknown, dependencies: CurateMcpDependencies): Promise<{ readonly metadata: CurateMetadata; readonly isError: boolean }> {
  const parsedArguments = curateArgumentsSchema.safeParse(argumentsValue);
  if (!parsedArguments.success) {
    return { metadata: blockedMetadata("Invalid curate input: payload, source, and optional exact projectHint are required; unknown fields are rejected"), isError: true };
  }
  let candidates: readonly CurationCandidate[];
  try {
    candidates = parseStrictPayload(parsedArguments.data.payload);
  } catch (error) {
    return {
      metadata: blockedMetadata(error instanceof Error ? `Curation rejected before persistence: ${error.message}` : "Curation rejected before persistence"),
      isError: true,
    };
  }
  try {
    // `source` is transport-origin metadata only; Local Curation V1 persists the canonical current-context provenance.
    const transportSource = parsedArguments.data.source;
    const result = await dependencies.curate(candidates, parsedArguments.data.projectHint ?? null);
    const metadata = metadataFromResult(result, transportSource);
    return { metadata, isError: metadata.decision === "DEFER" || metadata.decision === "REJECT" };
  } catch {
    return {
      metadata: blockedMetadata("Curation failed closed before persistence; no internal details were returned"),
      isError: true,
    };
  }
}

export function createSdkMcpServer(dependencies: CurateMcpDependencies = { curate: createConfiguredCurationHandler({ workspacePath: process.cwd() }) }): McpServer {
  const server = new McpServer({ name: "d-ai-local-curation", version: "0.1.0" });
  server.registerTool("curate", {
    description: toolDescription,
    inputSchema: curateArgumentsSchema,
  }, async (argumentsValue) => {
    const outcome = await executeCurate(argumentsValue, dependencies);
    return {
      content: [{ type: "text", text: JSON.stringify(outcome.metadata) }],
      ...(outcome.isError ? { isError: true } : {}),
    };
  });
  return server;
}

export async function runStdio(): Promise<void> {
  const server = createSdkMcpServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] !== undefined && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  await runStdio();
}
