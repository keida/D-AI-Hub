import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { redactSensitiveText } from "../adapters/command-runner.js";
import { createCodexExecutionBoundary } from "../automation/delivery.js";
import { readCurationPayload } from "../curation/curation-payload.js";
import { InvalidTaskStateError } from "../domain/errors.js";
import { parseApprovedTaskCharter } from "../state/task-charter.js";
import type { TaskCharter } from "../domain/types.js";
import { createCodexActivation, type CodexActivationResponse } from "./codex-activation.js";
import { createConfiguredDAIRuntime } from "../runtime/d-ai-runtime.js";

interface ParsedCLIArguments {
  readonly workspacePath: string;
  readonly rawCommand: string;
  readonly taskId: string | null;
  readonly curationPayloadPath: string | null;
  readonly memoryDatabasePath: string | null;
  readonly taskCharterPath: string | null;
  readonly confirmedTaskCharterDigest: string | null;
}

export interface CodexCLIResult {
  readonly exitCode: 0 | 2;
  readonly response: CodexActivationResponse;
}

function parseCLIArguments(arguments_: readonly string[]): ParsedCLIArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined || !["--workspace", "--command", "--task", "--curation-payload", "--memory-database", "--task-charter-file", "--approve-task-charter"].includes(flag)) {
      throw new InvalidTaskStateError("D-AI Codex entry requires --workspace <path> --command <logical-command> and optional --task <task-id>");
    }
    if (values.has(flag)) throw new InvalidTaskStateError(`D-AI Codex entry received duplicate ${flag}`);
    if (value.trim().length === 0) throw new InvalidTaskStateError(`D-AI Codex entry received an empty ${flag}`);
    values.set(flag, value);
  }
  const workspacePath = values.get("--workspace");
  const rawCommand = values.get("--command");
  if (workspacePath === undefined || rawCommand === undefined) {
    throw new InvalidTaskStateError("D-AI Codex entry requires --workspace <path> and --command <logical-command>");
  }
  const curationPayloadPath = values.get("--curation-payload") ?? null;
  const memoryDatabasePath = values.get("--memory-database") ?? null;
  const taskCharterPath = values.get("--task-charter-file") ?? null;
  const confirmedTaskCharterDigest = values.get("--approve-task-charter") ?? null;
  if (curationPayloadPath !== null && !isAbsolute(curationPayloadPath)) {
    throw new InvalidTaskStateError("Curation payload path must be absolute");
  }
  if (memoryDatabasePath !== null && !isAbsolute(memoryDatabasePath)) {
    throw new InvalidTaskStateError("Memory database path must be absolute");
  }
  if (taskCharterPath !== null && !isAbsolute(taskCharterPath)) {
    throw new InvalidTaskStateError("Task charter file path must be absolute");
  }
  if ((taskCharterPath === null) !== (confirmedTaskCharterDigest === null)) {
    throw new InvalidTaskStateError("Task charter file and explicit --approve-task-charter digest must be supplied together");
  }
  if (confirmedTaskCharterDigest !== null && !/^[a-f0-9]{64}$/u.test(confirmedTaskCharterDigest)) {
    throw new InvalidTaskStateError("Explicit task charter approval must be the exact lowercase SHA-256 digest");
  }
  return {
    workspacePath: resolve(workspacePath),
    rawCommand,
    taskId: values.get("--task") ?? null,
    curationPayloadPath,
    memoryDatabasePath,
    taskCharterPath,
    confirmedTaskCharterDigest,
  };
}

function blockedCLIResult(taskId: string | null, message: string): CodexCLIResult {
  return {
    exitCode: 2,
    response: {
      taskId: taskId ?? "unassigned",
      stage: "bootstrap",
      environment: "codex",
      status: "blocked",
      evidence: [],
      message: redactSensitiveText(message),
    },
  };
}

export async function runCodexCLI(arguments_: readonly string[]): Promise<CodexCLIResult> {
  const input = parseCLIArguments(arguments_);
  let curationCandidates;
  let taskCharter: TaskCharter | undefined;
  if (input.taskCharterPath !== null) {
    try {
      taskCharter = parseApprovedTaskCharter(JSON.parse(await readFile(input.taskCharterPath, "utf8")));
      if (input.confirmedTaskCharterDigest !== taskCharter.approval.approvedCharterDigest) {
        return blockedCLIResult(input.taskId, "Explicit task charter approval digest does not match the charter file");
      }
    } catch (error: unknown) {
      return blockedCLIResult(input.taskId, error instanceof Error ? error.message : "Task charter file could not be read or validated");
    }
  }
  if (input.curationPayloadPath !== null) {
    try {
      curationCandidates = (await readCurationPayload(input.curationPayloadPath)).candidates;
    } catch (error: unknown) {
      return blockedCLIResult(input.taskId, error instanceof Error ? error.message : "Curation payload could not be read");
    }
  }
  const activate = createCodexActivation(createConfiguredDAIRuntime({
    workspacePath: input.workspacePath,
    ...(input.memoryDatabasePath === null ? {} : { memoryDatabasePath: input.memoryDatabasePath }),
  }), {
    deliver: createCodexExecutionBoundary(),
  });
  const response = await activate({
    rawCommand: input.rawCommand,
    taskId: input.taskId,
    ...(curationCandidates === undefined ? {} : { currentContext: curationCandidates }),
    ...(taskCharter === undefined ? {} : { taskCharter }),
    ...(input.confirmedTaskCharterDigest === null ? {} : { confirmedTaskCharterDigest: input.confirmedTaskCharterDigest }),
  });
  return { exitCode: response.status === "blocked" ? 2 : 0, response };
}

async function runMain(): Promise<void> {
  try {
    const result = await runCodexCLI(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result.response, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error: unknown) {
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    process.stderr.write(`${JSON.stringify({ status: "blocked", environment: "codex", message })}\n`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await runMain();
}
