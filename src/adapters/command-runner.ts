import { spawn } from "node:child_process";
import { InvalidTaskStateError } from "../domain/errors.js";
import { redactSecretShapedValues } from "../domain/manifest-id.js";

export interface CommandRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string | null;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface CommandResult {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export class CommandExecutionError extends Error {
  public readonly result: CommandResult;

  public constructor(result: CommandResult) {
    super(`Command execution failed with exit code ${result.exitCode === null ? "no exit code" : result.exitCode}`);
    this.name = "CommandExecutionError";
    this.result = result;
  }
}

const secretAssignmentPattern = /((?:api[_-]?key|token|secret|password|passwd|auth|authorization|credential|access[_-]?token|private[_-]?key|cookie|session[_-]?token)\s*[:=]\s*)(?!bearer\b)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi;
const separateSecretArgumentPattern = /^--(?:api[_-]?key|token|secret|password|passwd|auth|authorization|credential|access[_-]?token|private[_-]?key|cookie|session[_-]?token)$/i;
const urlUserinfoPattern = /\b([a-z][a-z\d+.-]*:\/\/)[^\s/@]+@/gi;
const bearerValuePattern = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\']+)';
const authorizationBearerPattern = new RegExp(`(authorization\\s*:\\s*bearer\\s+)${bearerValuePattern}`, "gi");
const bearerTokenPattern = new RegExp(`(bearer\\s+)${bearerValuePattern}`, "gi");

export function redactSensitiveText(value: string): string {
  const redacted = value
    .replace(urlUserinfoPattern, "$1[REDACTED]@")
    .replace(authorizationBearerPattern, "$1[REDACTED]")
    .replace(secretAssignmentPattern, "$1[REDACTED]")
    .replace(bearerTokenPattern, "$1[REDACTED]");
  return redactSecretShapedValues(redacted);
}

function redactSensitiveArguments(argumentsList: readonly string[]): readonly string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const argument of argumentsList) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }
    redacted.push(redactSensitiveText(argument));
    redactNext = separateSecretArgumentPattern.test(argument);
  }
  return redacted;
}

function assertCommandRequest(request: CommandRequest): void {
  if (request.command.trim().length === 0) {
    throw new InvalidTaskStateError("Command must be non-empty");
  }
  if (request.command.includes("\0") || request.arguments.some((argument) => argument.includes("\0"))) {
    throw new InvalidTaskStateError("Command and arguments must not contain null bytes");
  }
  if (request.timeoutMs !== undefined && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new InvalidTaskStateError("Command timeout must be a positive integer when configured");
  }
  if (request.maxOutputBytes !== undefined && (!Number.isInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0)) {
    throw new InvalidTaskStateError("Command output limit must be a positive integer when configured");
  }
}

function createResult(request: CommandRequest, stdout: string, stderr: string, exitCode: number | null): CommandResult {
  return {
    command: redactSensitiveText(request.command),
    arguments: redactSensitiveArguments(request.arguments),
    stdout: redactSensitiveText(stdout),
    stderr: redactSensitiveText(stderr),
    exitCode,
  };
}

export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  assertCommandRequest(request);
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(request.command, [...request.arguments], {
      cwd: request.cwd === null ? undefined : request.cwd,
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const rejectWithResult = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      reject(new CommandExecutionError(result));
    };
    const appendOutput = (target: "stdout" | "stderr", chunk: string): void => {
      if (settled) return;
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
      const outputBytes = Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8");
      if (request.maxOutputBytes !== undefined && outputBytes > request.maxOutputBytes) {
        child.kill();
        rejectWithResult(createResult(request, stdout.slice(0, request.maxOutputBytes), "Command output exceeded the configured limit", null));
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendOutput("stderr", chunk));
    child.once("error", (error: Error) => {
      rejectWithResult(createResult(request, stdout, `Process launch failed: ${error.message}`, null));
    });
    child.once("close", (exitCode: number | null) => {
      if (settled) return;
      const result = createResult(request, stdout, stderr, exitCode);
      if (exitCode !== 0) {
        rejectWithResult(result);
        return;
      }
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    });
    if (request.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        child.kill();
        rejectWithResult(createResult(request, stdout, "Command timed out", null));
      }, request.timeoutMs);
    }
  });
}
