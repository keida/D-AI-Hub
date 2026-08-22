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

const secretAssignmentPattern = /((?:api[_-]?key|token|secret|password|passwd|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi;
const authorizationBearerPattern = /(authorization\s*:\s*bearer\s+)([^\s"']+)/gi;
const bearerTokenPattern = /(bearer\s+)([^\s"']+)/gi;

export function redactSensitiveText(value: string): string {
  const redacted = value
    .replace(authorizationBearerPattern, "$1[REDACTED]")
    .replace(secretAssignmentPattern, "$1[REDACTED]")
    .replace(bearerTokenPattern, "$1[REDACTED]");
  return redactSecretShapedValues(redacted);
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
    arguments: request.arguments.map(redactSensitiveText),
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
