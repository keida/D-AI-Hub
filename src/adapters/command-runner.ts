import { spawn } from "node:child_process";
import { InvalidTaskStateError } from "../domain/errors.js";
import { redactSecretShapedValues } from "../domain/manifest-id.js";

export interface CommandRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string | null;
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
const bearerValuePattern = '(?:"[^"]*"|\'[^\']*\'|[^\\s"\']+)';
const authorizationBearerPattern = new RegExp(`(authorization\\s*:\\s*bearer\\s+)${bearerValuePattern}`, "gi");
const bearerTokenPattern = new RegExp(`(bearer\\s+)${bearerValuePattern}`, "gi");

export function redactSensitiveText(value: string): string {
  const redacted = value
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
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error: Error) => {
      reject(new CommandExecutionError(createResult(request, stdout, `Process launch failed: ${error.message}`, null)));
    });
    child.once("close", (exitCode: number | null) => {
      const result = createResult(request, stdout, stderr, exitCode);
      if (exitCode !== 0) {
        reject(new CommandExecutionError(result));
        return;
      }
      resolve(result);
    });
  });
}
