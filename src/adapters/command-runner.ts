import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { InvalidTaskStateError } from "../domain/errors.js";
import { redactSecretShapedValues } from "../domain/manifest-id.js";

export interface CommandRequest {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string | null;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly terminateProcessTree?: ProcessTreeTerminator | undefined;
  readonly processTreeCleanup?: ProcessTreeCleanupOptions | undefined;
}

export interface ProcessTreeCleanupOptions {
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly runTaskkill?: ((pid: number, remainingMs: number, signal?: AbortSignal) => Promise<boolean>) | undefined;
  readonly queryProcessTree?: ((rootPid: number, remainingMs: number, signal?: AbortSignal) => Promise<readonly number[] | null>) | undefined;
  readonly sleep?: ((milliseconds: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly processIsAlive?: ((pid: number) => boolean) | undefined;
}

export type ProcessTreeTerminator = (child: ChildProcess, options?: ProcessTreeCleanupOptions) => Promise<boolean>;

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

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return value;
  let truncated = bytes.subarray(0, maxBytes);
  while (truncated.byteLength > 0) {
    const decoded = truncated.toString("utf8");
    if (Buffer.byteLength(decoded, "utf8") <= maxBytes) return decoded;
    truncated = truncated.subarray(0, truncated.byteLength - 1);
  }
  return "";
}

function createResult(request: CommandRequest, stdout: string, stderr: string, exitCode: number | null): CommandResult {
  const redactedStdout = redactSensitiveText(stdout);
  const redactedStderr = redactSensitiveText(stderr);
  if (request.maxOutputBytes === undefined) {
    return {
      command: redactSensitiveText(request.command),
      arguments: redactSensitiveArguments(request.arguments),
      stdout: redactedStdout,
      stderr: redactedStderr,
      exitCode,
    };
  }
  const boundedStdout = truncateUtf8(redactedStdout, request.maxOutputBytes);
  const stdoutBytes = Buffer.byteLength(boundedStdout, "utf8");
  const boundedStderr = truncateUtf8(redactedStderr, Math.max(0, request.maxOutputBytes - stdoutBytes));
  return {
    command: redactSensitiveText(request.command),
    arguments: redactSensitiveArguments(request.arguments),
    stdout: boundedStdout,
    stderr: boundedStderr,
    exitCode,
  };
}

function createDiagnosticResult(request: CommandRequest, stdout: string, stderr: string, reason: string): CommandResult {
  if (request.maxOutputBytes === undefined) {
    return createResult(request, stdout, `${reason}\n${stderr}`, null);
  }
  const redactedStdout = redactSensitiveText(stdout);
  const redactedStderr = redactSensitiveText(stderr);
  const redactedReason = redactSensitiveText(reason);
  const reasonBudget = Math.min(Buffer.byteLength(redactedReason, "utf8"), Math.floor(request.maxOutputBytes / 2));
  const separator = redactedStderr.length === 0 ? "" : "\n";
  const streamBudget = Math.max(0, request.maxOutputBytes - reasonBudget - Buffer.byteLength(separator, "utf8"));
  const stdoutBudget = Math.floor(streamBudget / 2);
  const stderrStreamBudget = streamBudget - stdoutBudget;
  const retainedReason = truncateUtf8(redactedReason, reasonBudget);
  return {
    command: redactSensitiveText(request.command),
    arguments: redactSensitiveArguments(request.arguments),
    stdout: truncateUtf8(redactedStdout, stdoutBudget),
    stderr: `${retainedReason}${separator}${truncateUtf8(redactedStderr, stderrStreamBudget)}`,
    exitCode: null,
  };
}

function createCleanupFailureResult(request: CommandRequest, result: CommandResult): CommandResult {
  const marker = "Process tree cleanup could not be established";
  const stderr = `${result.stderr}${result.stderr.length === 0 ? "" : "\n"}${marker}`;
  if (request.maxOutputBytes === undefined) return { ...result, stderr };
  const boundedStdout = truncateUtf8(result.stdout, request.maxOutputBytes);
  const remaining = Math.max(0, request.maxOutputBytes - Buffer.byteLength(boundedStdout, "utf8"));
  return { ...result, stdout: boundedStdout, stderr: truncateUtf8(stderr, remaining) };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type LinuxProcessStat = {
  readonly state: string;
  readonly processGroupId: number;
};

function readLinuxProcessStat(pid: number): LinuxProcessStat | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const processGroupId = Number(fields[2]);
    if (!Number.isInteger(processGroupId)) return null;
    return { state: fields[0] ?? "unknown", processGroupId };
  } catch {
    return null;
  }
}

function linuxProcessGroupHasActiveMembers(processGroupId: number): boolean {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readLinuxProcessStat(Number(entry));
    if (stat?.processGroupId === processGroupId && stat.state !== "Z") return true;
  }
  return false;
}

function processTreeHasActiveMembers(pid: number, processGroupId: number): boolean {
  if (process.platform === "linux") return linuxProcessGroupHasActiveMembers(processGroupId);
  return processIsAlive(pid);
}

async function waitForProcessTreeCleanup(pid: number, processGroupId: number, options: ProcessTreeCleanupOptions): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (timeoutMs <= 0) return false;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / 10) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (!processTreeHasActiveMembers(pid, processGroupId)) return true;
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await sleep(Math.min(10, remainingMs));
  }
  return !processTreeHasActiveMembers(pid, processGroupId);
}

function runTaskkill(taskkill: string, pid: number, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const killer = spawn(taskkill, ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      if (settled) return;
      try {
        killer.kill("SIGKILL");
      } catch {
        // The bounded operation remains failed closed if the helper already exited.
      } finally {
        finish(false);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish(false), timeoutMs);
    killer.once("close", (exitCode) => finish(exitCode === 0));
    killer.once("error", () => finish(false));
  });
}

function queryWindowsProcessTree(powerShell: string, rootPid: number, timeoutMs: number, signal?: AbortSignal): Promise<readonly number[] | null> {
  if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(null);
  return new Promise<readonly number[] | null>((resolve) => {
    const script = [
      "$root =", String(rootPid), ";",
      "$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId);",
      "$pending = [System.Collections.Generic.Queue[int]]::new();",
      "$seen = [System.Collections.Generic.HashSet[int]]::new();",
      "$pending.Enqueue($root);",
      "while ($pending.Count -gt 0) { $parent = $pending.Dequeue(); foreach ($process in $processes) { if ([int]$process.ParentProcessId -eq $parent -and $seen.Add([int]$process.ProcessId)) { $pending.Enqueue([int]$process.ProcessId) } } }",
      "$seen -join ','",
    ].join(" ");
    const query = spawn(powerShell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    let stdout = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: readonly number[] | null): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      if (settled) return;
      try {
        query.kill("SIGKILL");
      } catch {
        // The bounded operation remains failed closed if the helper already exited.
      } finally {
        finish(null);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish(null), timeoutMs);
    query.stdout.setEncoding("utf8");
    query.stdout.on("data", (chunk: string) => {
      if (Buffer.byteLength(stdout, "utf8") <= 65_536) stdout += chunk;
    });
    query.once("error", () => finish(null));
    query.once("close", (exitCode) => {
      if (exitCode !== 0) {
        finish(null);
        return;
      }
      const values = stdout.trim().length === 0 ? [] : stdout.trim().split(",").map(Number);
      finish(values.every((value) => Number.isInteger(value) && value > 0) ? values : null);
    });
  });
}

type TimedCleanupOperation<T> =
  | { readonly completed: true; readonly value: T }
  | { readonly completed: false };

function runWithinCleanupDeadline<T>(deadline: number, now: () => number, operation: (signal: AbortSignal) => Promise<T>): Promise<TimedCleanupOperation<T>> {
  const remainingMs = Math.max(0, deadline - now());
  if (remainingMs <= 0) return Promise.resolve({ completed: false });
  const controller = new AbortController();
  return new Promise<TimedCleanupOperation<T>>((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: TimedCleanupOperation<T>): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      controller.abort();
      finish({ completed: false });
    }, Math.max(1, remainingMs));
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          if (now() >= deadline) {
            controller.abort();
            finish({ completed: false });
            return;
          }
          finish({ completed: true, value });
        },
        () => finish({ completed: false }),
      );
  });
}

export async function terminateProcessTree(child: ChildProcess, options: ProcessTreeCleanupOptions = {}): Promise<boolean> {
  const pid = child.pid;
  if (pid === undefined) return false;
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    const powerShell = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const now = options.now ?? (() => performance.now());
    const deadline = now() + (options.timeoutMs ?? 5_000);
    const remaining = (): number => Math.max(0, deadline - now());
    const kill = options.runTaskkill ?? ((descendantPid: number, remainingMs: number, signal?: AbortSignal) => runTaskkill(taskkill, descendantPid, remainingMs, signal));
    const query = options.queryProcessTree ?? ((rootPid: number, remainingMs: number, signal?: AbortSignal) => queryWindowsProcessTree(powerShell, rootPid, remainingMs, signal));
    const sleep = options.sleep ?? ((milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      timer = setTimeout(finish, milliseconds);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted) {
        finish();
      }
    }));
    const isAlive = options.processIsAlive ?? processIsAlive;
    const initialQuery = await runWithinCleanupDeadline(deadline, now, (signal) => query(pid, remaining(), signal));
    if (!initialQuery.completed) return false;
    const knownDescendants = initialQuery.value;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const budget = remaining();
      if (budget <= 0) break;
      const killResult = await runWithinCleanupDeadline(deadline, now, (signal) => kill(pid, budget, signal));
      if (!killResult.completed) return false;
      const observedResult = await runWithinCleanupDeadline(deadline, now, (signal) => query(pid, remaining(), signal));
      if (!observedResult.completed) return false;
      const observed = observedResult.value;
      if (observed !== null && observed.length === 0 && !isAlive(pid)) return true;
      const fallbackDescendants = observed ?? knownDescendants;
      if (fallbackDescendants !== null) {
        for (const descendantPid of [...fallbackDescendants].reverse()) {
          const descendantBudget = remaining();
          if (descendantBudget <= 0) break;
          const descendantKill = await runWithinCleanupDeadline(deadline, now, (signal) => kill(descendantPid, descendantBudget, signal));
          if (!descendantKill.completed) return false;
        }
      }
      const pauseBudget = remaining();
      if (pauseBudget <= 0) break;
      const pause = await runWithinCleanupDeadline(deadline, now, (signal) => sleep(Math.min(200, pauseBudget), signal));
      if (!pause.completed) return false;
      const afterFallbackResult = await runWithinCleanupDeadline(deadline, now, (signal) => query(pid, remaining(), signal));
      if (!afterFallbackResult.completed) return false;
      const afterFallback = afterFallbackResult.value;
      if (afterFallback !== null && afterFallback.length === 0 && !isAlive(pid)) return true;
      if (remaining() <= 0) break;
      if (afterFallback !== null && afterFallback.length > 0 && !isAlive(pid)) continue;
      if (afterFallback === null && attempt === 0) continue;
      if (afterFallback !== null && afterFallback.length > 0) continue;
      break;
    }
    return false;
  }
  try {
    process.kill(-pid, "SIGKILL");
    const processGroupId = process.platform === "linux" ? (readLinuxProcessStat(pid)?.processGroupId ?? pid) : pid;
    return await waitForProcessTreeCleanup(pid, processGroupId, options);
  } catch {
    return false;
  }
}

function terminateProcessTreeForRequest(child: ChildProcess, options: ProcessTreeCleanupOptions | undefined): Promise<boolean> {
  return terminateProcessTree(child, options);
}

export async function runCommand(request: CommandRequest): Promise<CommandResult> {
  assertCommandRequest(request);
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(request.command, [...request.arguments], {
      cwd: request.cwd === null ? undefined : request.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let terminationStarted = false;
    let outputOverflowed = false;
    let timeout: NodeJS.Timeout | undefined;
    const rejectWithResult = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      reject(new CommandExecutionError(result));
    };
    const terminateAndReject = (result: CommandResult): void => {
      if (settled || terminationStarted) return;
      terminationStarted = true;
      const terminator = request.terminateProcessTree ?? terminateProcessTreeForRequest;
      void Promise.resolve().then(() => terminator(child, request.processTreeCleanup)).then(
        (cleanupEstablished) => rejectWithResult(cleanupEstablished ? result : createCleanupFailureResult(request, result)),
        () => rejectWithResult(createCleanupFailureResult(request, result)),
      );
    };
    const appendDiagnosticOutput = (target: "stdout" | "stderr", chunk: string): void => {
      if (request.maxOutputBytes === undefined) return;
      const budget = target === "stdout"
        ? Math.floor(request.maxOutputBytes / 2)
        : request.maxOutputBytes - Math.floor(request.maxOutputBytes / 2);
      if (target === "stdout") stdout = truncateUtf8(stdout + chunk, budget);
      else stderr = truncateUtf8(stderr + chunk, budget);
    };
    const appendOutput = (target: "stdout" | "stderr", chunk: string): void => {
      if (settled || terminationStarted) return;
      if (outputOverflowed) {
        appendDiagnosticOutput(target, chunk);
        return;
      }
      const chunkBytes = Buffer.from(chunk, "utf8");
      if (request.maxOutputBytes !== undefined && outputBytes + chunkBytes.byteLength > request.maxOutputBytes) {
        outputOverflowed = true;
        appendDiagnosticOutput(target, chunk);
        setImmediate(() => terminateAndReject(createDiagnosticResult(request, stdout, stderr, "Command output exceeded the configured limit")));
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
      outputBytes += chunkBytes.byteLength;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendOutput("stderr", chunk));
    child.once("error", (error: Error) => {
      if (terminationStarted) return;
      rejectWithResult(createDiagnosticResult(request, stdout, stderr, `Process launch failed: ${error.message}`));
    });
    child.once("close", (exitCode: number | null) => {
      if (settled || terminationStarted) return;
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
        terminateAndReject(createDiagnosticResult(request, stdout, stderr, "Command timed out"));
      }, request.timeoutMs);
    }
  });
}
