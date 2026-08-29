import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { InvalidTaskStateError } from "../domain/errors.js";
import { exportMemoryBundle, importMemoryBundle } from "./memory-bundle-codec.js";
import { LocalSqliteMemoryStore } from "./local-sqlite-memory-store.js";
import type { LocalSqliteMemoryStoreOptions, MemoryStoreMode, MemoryValue } from "./types.js";

type MemoryCommand = "put" | "get" | "export" | "import";

interface ParsedMemoryArguments {
  readonly command: MemoryCommand;
  readonly database: string;
  readonly workspace: string;
  readonly scope: string;
  readonly writer: string;
  readonly mode: MemoryStoreMode;
  readonly bundle: string | undefined;
  readonly bundleId: string | undefined;
  readonly memoryId: string | undefined;
  readonly value: MemoryValue | undefined;
  readonly recordedAt: string | undefined;
  readonly createdAt: string | undefined;
  readonly afterSequence: number | undefined;
}

export interface MemoryCLIResult {
  readonly exitCode: 0 | 1;
  readonly output: unknown;
}

const commonOptions = ["database", "workspace", "scope", "writer", "mode"] as const;
const optionNames = new Set([
  "database", "workspace", "scope", "writer", "mode", "bundle", "bundle-id", "memory-id", "value", "recorded-at", "created-at", "after-sequence",
]);

function optionName(argument: string): string {
  if (!argument.startsWith("--") || argument.length === 2) throw new InvalidTaskStateError(`Unknown memory CLI argument ${argument}`);
  const name = argument.slice(2);
  if (!optionNames.has(name)) throw new InvalidTaskStateError(`Unknown memory CLI option --${name}`);
  return name;
}

function requireOption(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0) throw new InvalidTaskStateError(`Memory CLI requires --${name} <value>`);
  return value;
}

function parseMode(value: string): MemoryStoreMode {
  if (value !== "reader" && value !== "writer") throw new InvalidTaskStateError("Memory CLI --mode must be reader or writer");
  return value;
}

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidTaskStateError(`Memory CLI --${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new InvalidTaskStateError(`Memory CLI --${name} must be a safe integer`);
  return parsed;
}

function parseValue(value: string): MemoryValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new InvalidTaskStateError("Memory CLI --value must be valid JSON");
  }
  return parsed as MemoryValue;
}

function parseArguments(arguments_: readonly string[]): ParsedMemoryArguments {
  const command = arguments_[0];
  if (command !== "put" && command !== "get" && command !== "export" && command !== "import") {
    throw new InvalidTaskStateError("Memory CLI requires one command: put, get, export, or import");
  }
  const values = new Map<string, string>();
  for (let index = 1; index < arguments_.length; index += 1) {
    const name = optionName(arguments_[index]!);
    if (values.has(name)) throw new InvalidTaskStateError(`Memory CLI option --${name} was provided more than once`);
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) throw new InvalidTaskStateError(`Memory CLI requires --${name} <value>`);
    values.set(name, value);
    index += 1;
  }

  for (const name of commonOptions) requireOption(values, name);
  const database = requireOption(values, "database");
  const workspace = requireOption(values, "workspace");
  const scope = requireOption(values, "scope");
  const writer = requireOption(values, "writer");
  const mode = parseMode(requireOption(values, "mode"));
  const bundle = values.get("bundle");
  const bundleId = values.get("bundle-id");
  const memoryId = values.get("memory-id");
  const value = values.has("value") ? parseValue(requireOption(values, "value")) : undefined;
  const recordedAt = values.get("recorded-at");
  const createdAt = values.get("created-at");
  const afterSequenceValue = values.get("after-sequence");
  const afterSequence = afterSequenceValue === undefined ? undefined : parseNonNegativeInteger(afterSequenceValue, "after-sequence");

  if (command === "put") {
    requireOption(values, "memory-id");
    requireOption(values, "value");
  } else if (command === "get") {
    requireOption(values, "memory-id");
  } else if (command === "export") {
    requireOption(values, "bundle");
  } else {
    requireOption(values, "bundle");
  }
  const allowed = new Set(command === "put"
    ? [...commonOptions, "memory-id", "value", "recorded-at"]
    : command === "get"
      ? [...commonOptions, "memory-id"]
      : command === "export"
        ? [...commonOptions, "bundle", "bundle-id", "created-at", "after-sequence"]
        : [...commonOptions, "bundle"]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new InvalidTaskStateError(`Memory CLI option --${name} is not valid for ${command}`);
  }

  return { command, database, workspace, scope, writer, mode, bundle, bundleId, memoryId, value, recordedAt, createdAt, afterSequence };
}

function blocked(error: unknown): MemoryCLIResult {
  return {
    exitCode: 1,
    output: {
      status: "blocked",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

export async function runMemoryCLI(arguments_: readonly string[]): Promise<MemoryCLIResult> {
  let parsed: ParsedMemoryArguments;
  try {
    parsed = parseArguments(arguments_);
  } catch (error) {
    return blocked(error);
  }

  let store: LocalSqliteMemoryStore | undefined;
  try {
    const storeOptions: LocalSqliteMemoryStoreOptions = {
      databasePath: parsed.database,
      workspacePath: parsed.workspace,
      mode: parsed.mode,
      scopeId: parsed.scope,
      writerId: parsed.writer,
    };
    if (parsed.command === "import") {
      const receipt = await importMemoryBundle(storeOptions, parsed.bundle!);
      return { exitCode: receipt.outcome === "BLOCKED" ? 1 : 0, output: receipt };
    }
    store = new LocalSqliteMemoryStore(storeOptions);
    if (parsed.command === "put") {
      const record = await store.put({
        memoryId: parsed.memoryId!,
        value: parsed.value!,
        recordedAt: parsed.recordedAt ?? new Date().toISOString(),
      });
      return { exitCode: 0, output: record };
    }
    if (parsed.command === "get") {
      return { exitCode: 0, output: await store.get(parsed.memoryId!) };
    }
    if (parsed.command === "export") {
      const exportOptions: { bundleId?: string; createdAt?: string; afterSequence?: number } = {};
      if (parsed.bundleId !== undefined) exportOptions.bundleId = parsed.bundleId;
      if (parsed.createdAt !== undefined) exportOptions.createdAt = parsed.createdAt;
      if (parsed.afterSequence !== undefined) exportOptions.afterSequence = parsed.afterSequence;
      const bundle = await exportMemoryBundle(store, parsed.bundle!, {
        ...exportOptions,
      });
      return { exitCode: 0, output: bundle.manifest };
    }
    throw new InvalidTaskStateError("Memory CLI command is not supported");
  } catch (error) {
    return blocked(error);
  } finally {
    store?.close();
  }
}

async function runMain(): Promise<void> {
  const result = await runMemoryCLI(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.output)}\n`);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await runMain();
}
