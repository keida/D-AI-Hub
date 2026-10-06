import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CommandExecutionError, runCommand } from "../../src/adapters/command-runner.js";
import { LocalSqliteMemoryStore } from "../../src/memory/local-sqlite-memory-store.js";
import { resolveLocalMemoryScopeId } from "../../src/memory/local-memory-path.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { runCodexCLI } from "../../src/entry/codex-cli.js";
import type { CodexActivationResponse } from "../../src/entry/codex-activation.js";
import { buildCurationBoundarySha256, createCurationPipeline, hashCurationSourceKey, type CurationPipelineInput } from "../../src/curation/current-view-pipeline.js";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface ProcessResult {
  readonly diagnosticId: string;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly npmLog: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutPreview: Buffer<ArrayBufferLike>;
  readonly stderrPreview: Buffer<ArrayBufferLike>;
  readonly stdoutEnded: boolean;
  readonly stderrEnded: boolean;
  readonly npmLogBytes: number;
  readonly npmLogPreview: Buffer<ArrayBufferLike>;
  readonly npmLogCaptured: boolean;
  readonly npmLogCaptureReason: string | null;
  readonly timedOut: boolean;
  readonly powerShellExecutablePath: string;
  readonly modulePathStrategy: "powershell-home-modules" | "legacy-unset";
  readonly invocationMode: "in-process-bootstrap" | "legacy-direct-file";
  readonly moduleBootstrapEvidence: ModuleBootstrapEvidence | null;
  readonly parentPSModulePathStatus: "NOT_PROVIDED" | "PROVIDED";
  readonly parentPSModulePathSha256: string | null;
  readonly childPSModulePath: string | null;
}

interface ModuleBootstrapEvidence {
  readonly diagnosticId: string;
  readonly invocationMode: "in-process-call-operator";
  readonly modulePathBefore: string | null;
  readonly modulePathAfter: string;
  readonly expectedModulePath: string;
  readonly verification: "MATCH";
}

const diagnosticStreamLimit = 8 * 1024;

function emitProcessDiagnostic(diagnostic: Readonly<Record<string, unknown>>): void {
  try { process.stderr.write(`POWERSHELL_INVOCATION_DIAGNOSTIC ${JSON.stringify(diagnostic)}\n`); } catch { /* Diagnostics must not change invocation control. */ }
}

function capturedStreamDiagnostic(bytes: number, preview: Buffer, ended: boolean, byteCountBasis = "original-child-stream-buffer-bytes"): Readonly<Record<string, unknown>> {
  const retainedBytes = preview.length;
  return {
    status: bytes > 0 && ended ? "CAPTURED" : bytes === 0 && ended ? "CAPTURED_EMPTY" : "NOT_CAPTURED",
    byteCountBasis,
    totalOriginalBytes: bytes,
    streamEnded: ended,
    partialCapture: bytes > 0 && !ended,
    truncated: bytes > retainedBytes,
    retainedRange: retainedBytes === 0 ? null : { startByteInclusive: 0, endByteExclusive: retainedBytes },
    retainedPrefixBase64: retainedBytes === 0 ? null : preview.toString("base64"),
  };
}

function boundedDiagnosticText(value: string, maxCharacters = 2_000): Readonly<Record<string, unknown>> {
  const retainedText = value.slice(0, maxCharacters);
  return {
    text: retainedText,
    originalCharacters: value.length,
    characterCountBasis: "JavaScript string characters",
    retainedRange: { startCharacterInclusive: 0, endCharacterExclusive: retainedText.length },
    retainedUtf8Bytes: Buffer.byteLength(retainedText, "utf8"),
    retainedUtf8ByteCountBasis: "UTF-8 encoding of retained JavaScript string; not original stream bytes",
    truncated: value.length > maxCharacters,
  };
}

function boundedDiagnosticError(error: unknown): Readonly<Record<string, unknown>> {
  return error instanceof Error
    ? { name: boundedDiagnosticText(error.name, 128), ...boundedDiagnosticText(error.message) }
    : boundedDiagnosticText(String(error));
}

function observedAt(value: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> {
  return value === null ? { status: "NOT OBSERVED" } : { status: "OBSERVED", ...value };
}

interface TreeStopObservation {
  readonly processId: number;
  readonly status: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly taskkillExitCode: number | null;
  readonly taskkillTimedOut: boolean;
  readonly taskkillStdoutStatus: "NOT_CAPTURED";
  readonly taskkillStderrText: string;
  readonly taskkillStderrRawBytes: number;
  readonly taskkillStderrRetainedCharacters: number;
  readonly taskkillStderrTruncated: boolean;
  readonly taskkillStderrRetainedRange: { readonly startCharacterInclusive: number; readonly endCharacterExclusive: number } | null;
}

const integrationFileStartedAt = performance.now();
let powershellLaunchCount = 0;
let npmCommandAttemptCount = 0;
let npmPathSearchMs = 0;
let runtimeNpmCmd: string | undefined;
let maximumInheritedPathLength = 0;
const activeTreeStops = new Set<() => Promise<void>>();
const activeEnvironmentRoots = new Set<string>();
let maximumEnvironmentPathLength = 0;
let maximumNpmLogPathLength = 0;
const powerShellExecutableCache = new Map<string, string>();
const inProcessModuleBootstrap = [
  "[CmdletBinding()]",
  "param(",
  "  [Parameter(Mandatory = $true)][string]$DiagnosticId,",
  "  [Parameter(Mandatory = $true)][string]$BootstrapEvidencePath,",
  "  [Parameter(Mandatory = $true)][string]$BootstrapArgumentsPath,",
  "  [Parameter(Mandatory = $true)][string]$TargetParameterContract",
  ")",
  "$powerShellHome = [string]$PSHOME",
  "$expectedModulePath = [System.IO.Path]::Combine($powerShellHome, 'Modules')",
  "if (-not [System.IO.Directory]::Exists($expectedModulePath)) { [System.Console]::Error.WriteLine('PowerShell system Modules directory is missing'); exit 1 }",
  "$modulePathBefore = [System.Environment]::GetEnvironmentVariable('PSModulePath', 'Process')",
  "[System.Environment]::SetEnvironmentVariable('PSModulePath', $expectedModulePath, 'Process')",
  "$modulePathAfter = [System.Environment]::GetEnvironmentVariable('PSModulePath', 'Process')",
  "if ([string]::Compare($modulePathAfter, $expectedModulePath, [System.StringComparison]::OrdinalIgnoreCase) -ne 0) { [System.Console]::Error.WriteLine('Effective PSModulePath does not match PSHOME\\Modules'); exit 1 }",
  "$modulePathBeforeStatus = if ($null -eq $modulePathBefore) { 'NOT_PROVIDED' } else { 'PROVIDED' }",
  "$bootstrapEvidenceLines = [string[]]@('v1', $DiagnosticId, 'in-process-call-operator', $modulePathBeforeStatus, [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$modulePathBefore)), [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($modulePathAfter)), [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($expectedModulePath)), 'MATCH')",
  "[System.IO.File]::WriteAllText($BootstrapEvidencePath, [string]::Join([System.Environment]::NewLine, $bootstrapEvidenceLines), [System.Text.UTF8Encoding]::new($false))",
  "$bootstrapArguments = [System.IO.File]::ReadAllLines($BootstrapArgumentsPath)",
  "if ($bootstrapArguments.Length -lt 2) { throw 'Bootstrap argument record is incomplete' }",
  "$decodeArgument = { param([string]$Value) [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value)) }",
  "$targetScriptPath = & $decodeArgument $bootstrapArguments[0]",
  "$targetWorkingDirectory = & $decodeArgument $bootstrapArguments[1]",
  "Set-Location -LiteralPath $targetWorkingDirectory",
  "$targetParameterNames = switch ($TargetParameterContract) {",
  "  'invoke' { @('CommandText', 'TaskId', 'WorkspacePath', 'CurationPayloadPath', 'CurationSourceWindowPath', 'MemoryDatabasePath', 'TaskCharterFile', 'ApproveTaskCharterDigest'); break }",
  "  'set-runtime-binding' { @('SkillRoot', 'RuntimeRoot'); break }",
  "  'none' { @(); break }",
  "  default { throw 'Unsupported test-only PowerShell parameter contract' }",
  "}",
  "$targetParameters = @{}",
  "for ($index = 2; $index -lt $bootstrapArguments.Length; $index += 2) {",
  "  $parameterName = & $decodeArgument $bootstrapArguments[$index]",
  "  if (-not $parameterName.StartsWith('-') -or $index + 1 -ge $bootstrapArguments.Length) { throw 'Bootstrap argument record has an invalid parameter pair' }",
  "  $name = $parameterName.Substring(1)",
  "  if ($targetParameterNames -notcontains $name) { throw 'Bootstrap argument record contains a parameter outside its contract' }",
  "  $targetParameters[$name] = & $decodeArgument $bootstrapArguments[$index + 1]",
  "}",
  "$global:LASTEXITCODE = $null",
  "try {",
  "  & $targetScriptPath @targetParameters",
  "  $targetSucceeded = $?",
  "  $targetExitCode = $global:LASTEXITCODE",
  "  if (-not $targetSucceeded) { if ($null -ne $targetExitCode) { exit ([int]$targetExitCode) }; exit 1 }",
  "  exit 0",
  "} catch {",
  "  [System.Console]::Error.WriteLine($_.ToString())",
  "  exit 1",
  "}",
].join("\r\n");

function resolvePowerShellExecutable(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot;
  if (systemRoot === undefined) throw new Error("SystemRoot is required to resolve powershell.exe");
  const cacheKey = `${systemRoot}\0${environment.PATH ?? ""}\0${environment.PATHEXT ?? ""}`;
  const cached = powerShellExecutableCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const lookup = spawnSync(join(systemRoot, "System32", "where.exe"), ["powershell.exe"], { encoding: "utf8", windowsHide: true, env: environment });
  if (lookup.error) throw lookup.error;
  const executable = lookup.stdout.split(/\r?\n/u).map((candidate) => candidate.trim()).find(Boolean);
  if (lookup.status !== 0 || executable === undefined || !existsSync(executable)) {
    throw new Error(`Could not resolve powershell.exe from the invocation PATH (where exit ${lookup.status ?? "unknown"})`);
  }
  const resolved = executable;
  powerShellExecutableCache.set(cacheKey, resolved);
  return resolved;
}

afterEach(async () => {
  const cleanupResults = await Promise.allSettled([...activeTreeStops].map((stop) => stop()));
  activeTreeStops.clear();
  await Promise.all([...activeEnvironmentRoots].map((root) => rm(root, { recursive: true, force: true })));
  activeEnvironmentRoots.clear();
  const cleanupFailure = cleanupResults.find((result) => result.status === "rejected");
  if (cleanupFailure?.status === "rejected") throw cleanupFailure.reason;
});

afterAll(() => {
  console.log(`SKILL_ENTRY_FILE_METRICS ${JSON.stringify({
    elapsedMs: Math.round(performance.now() - integrationFileStartedAt),
    powershellLaunches: powershellLaunchCount,
    npmShimEntries: npmCommandAttemptCount,
    npmPathSearchMs: Math.round(npmPathSearchMs),
    maximumInheritedPathLength,
    maximumEnvironmentPathLength,
    maximumNpmLogPathLength,
  })}`);
});

function runPowerShell(scriptPath: string, workspacePath: string, commandText: string, signal: AbortSignal): Promise<ProcessResult> {
  return runPowerShellArguments(scriptPath, workspacePath, [
    "-WorkspacePath",
    workspacePath,
    "-CommandText",
    commandText,
  ], signal);
}

async function terminateProcessTree(processId: number, observe?: (observation: TreeStopObservation) => void): Promise<void> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  let observationSent = false;
  const report = (status: string, taskkillExitCode: number | null, taskkillTimedOut: boolean, stderr: string, stderrBytes: number) => {
    if (observationSent) return;
    observationSent = true;
    try {
      observe?.({
        processId,
        status,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - started),
        taskkillExitCode,
        taskkillTimedOut,
        taskkillStdoutStatus: "NOT_CAPTURED",
        taskkillStderrText: stderr.slice(0, diagnosticStreamLimit),
        taskkillStderrRawBytes: stderrBytes,
        taskkillStderrRetainedCharacters: Math.min(stderr.length, diagnosticStreamLimit),
        taskkillStderrTruncated: stderr.length > diagnosticStreamLimit,
        taskkillStderrRetainedRange: stderr.length === 0 ? null : { startCharacterInclusive: 0, endCharacterExclusive: Math.min(stderr.length, diagnosticStreamLimit) },
      });
    } catch { /* Observability cannot change process-tree termination. */ }
  };
  if (process.platform !== "win32") {
    try {
      process.kill(-processId, "SIGKILL");
      report("SIGKILL_REQUESTED", null, false, "", 0);
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") report("PROCESS_GROUP_ALREADY_ABSENT", null, false, "", 0);
      else { report("SIGKILL_FAILED", null, false, "", 0); throw error; }
    }
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn("taskkill.exe", ["/PID", String(processId), "/T", "/F"], { windowsHide: true });
    let stderr = "";
    let stderrBytes = 0;
    const stderrDecoder = new StringDecoder("utf8");
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      killer.kill();
      stderr += stderrDecoder.end();
      report("TASKKILL_TIMEOUT", null, true, stderr, stderrBytes);
      finish(new Error(`Timed out terminating PowerShell process tree ${processId}`));
    }, 1_500);
    killer.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; stderr += stderrDecoder.write(chunk); });
    killer.once("error", (error) => { stderr += stderrDecoder.end(); report("TASKKILL_SPAWN_ERROR", null, false, stderr, stderrBytes); finish(error); });
    killer.once("close", (exitCode) => {
      stderr += stderrDecoder.end();
      if (exitCode === 0) { report("TASKKILL_EXIT_ZERO", exitCode, false, stderr, stderrBytes); finish(); }
      else if (/not found|does not exist/iu.test(stderr) && !isProcessRunning(processId)) { report("TASKKILL_NOT_FOUND_PARENT_ABSENT", exitCode, false, stderr, stderrBytes); finish(); }
      else { report("TASKKILL_FAILED", exitCode, false, stderr, stderrBytes); finish(new Error(`taskkill failed for process tree ${processId} (${exitCode}): ${stderr.slice(0, 2_000)}`)); }
    });
  });
}

async function runPowerShellArguments(scriptPath: string, cwdPath: string, argumentsList: readonly string[], signal: AbortSignal, pathPrefix?: string, timeoutMs?: number, diagnosticLabel?: string, modulePathStrategy: ProcessResult["modulePathStrategy"] = "powershell-home-modules"): Promise<ProcessResult> {
  const invocationId = randomUUID();
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const stage = diagnosticLabel ?? "powershell-invocation";
  const invocationMode = modulePathStrategy === "legacy-unset" ? "legacy-direct-file" : "in-process-bootstrap";
  const parentPSModulePath = process.env.PSModulePath;
  const parentPSModulePathStatus = parentPSModulePath === undefined ? "NOT_PROVIDED" : "PROVIDED";
  const parentPSModulePathSha256 = parentPSModulePath === undefined ? null : createHash("sha256").update(parentPSModulePath, "utf8").digest("hex");
  let environmentRoot: string | null = null;
  let powerShellExecutablePath: string | null = null;
  let expectedModulePath: string | null = null;
  let bootstrapEvidencePath: string | null = null;
  let bootstrapArgumentsPath: string | null = null;
  let bootstrapScriptPath: string | null = null;
  let npmMarkerPath: string | null = null;
  let envReadyAt: Readonly<Record<string, unknown>> | null = null;
  let commandArguments = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...argumentsList];
  const notCaptured = capturedStreamDiagnostic(0, Buffer.alloc(0), false);
  const emitBeforeSpawn = (event: string, error: unknown, abortOrigin: string | null) => emitProcessDiagnostic({
    schemaVersion: 1, invocationId, stage, event, startedAt, eventAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
    command: {
      program: "powershell.exe",
      arguments: { totalCount: argumentsList.length + 5, retained: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...argumentsList].slice(0, 32).map((argument) => boundedDiagnosticText(argument, 512)), truncated: argumentsList.length + 5 > 32 },
      cwd: boundedDiagnosticText(cwdPath),
      timeoutMs: timeoutMs ?? null,
    },
    environmentPrepared: envReadyAt !== null, envReadyAt: observedAt(envReadyAt), abortOrigin: abortOrigin ?? "NOT OBSERVED",
    moduleEnvironment: {
      strategy: modulePathStrategy,
      invocationMode,
      parentPSModulePath: { status: parentPSModulePathStatus, sha256: parentPSModulePathSha256 },
      childPSModulePath: { status: "NOT OBSERVED" },
      bootstrapEvidence: { status: "NOT OBSERVED" },
      resolvedPowerShellExecutable: powerShellExecutablePath === null ? { status: "NOT OBSERVED" } : { status: "RESOLVED", path: powerShellExecutablePath },
    },
    spawnedAt: { status: "NOT OBSERVED" },
    rootProcessId: { status: "NOT OBSERVED" },
    firstStdoutAt: { status: "NOT OBSERVED" },
    firstStderrAt: { status: "NOT OBSERVED" },
    exit: { observedAt: { status: "NOT OBSERVED" }, code: "NOT OBSERVED", signal: "NOT OBSERVED" },
    close: { observedAt: { status: "NOT OBSERVED" }, code: "NOT OBSERVED", eventObserved: false, processingComplete: false },
    stopRequest: { origin: "NOT OBSERVED", at: { status: "NOT OBSERVED" } },
    cleanup: {
      stopOutcome: "NOT OBSERVED",
      stopStartedAt: { status: "NOT OBSERVED" },
      stopCompletedAt: { status: "NOT OBSERVED" },
      treeStopObservation: { status: "NOT OBSERVED" },
      closeWaitStartedAt: { status: "NOT OBSERVED" },
      closeWaitOutcome: "NOT OBSERVED",
      rootCloseEventObserved: false,
      error: { status: "NOT OBSERVED" },
    },
    failure: error instanceof Error ? { name: boundedDiagnosticText(error.name, 128), ...boundedDiagnosticText(error.message) } : error === null ? { status: "NOT OBSERVED" } : boundedDiagnosticText(String(error)),
    streams: { stdout: notCaptured, stderr: notCaptured },
    npmMarker: npmMarkerPath === null ? { status: "NOT_APPLICABLE", reason: "runtime npm tracking shim was not configured" } : npmMarkerSnapshot(npmMarkerPath),
  });
  if (signal?.aborted) {
    const error = new Error("The Vitest test was aborted before starting a PowerShell invocation");
    emitBeforeSpawn("rejected-before-spawn", error, "owning-test-cancellation");
    throw error;
  }

  const env: NodeJS.ProcessEnv = {};
  try {
    environmentRoot = join(tmpdir(), `e-${randomUUID()}`);
    activeEnvironmentRoots.add(environmentRoot);
    maximumEnvironmentPathLength = Math.max(maximumEnvironmentPathLength, environmentRoot.length);
    for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "SystemDrive", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    for (const [key, directory] of Object.entries({ HOME: "home", USERPROFILE: "home", APPDATA: "appdata", LOCALAPPDATA: "localappdata", TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp", XDG_DATA_HOME: "xdg-data", NPM_CONFIG_CACHE: "npm-cache" })) {
      env[key] = join(environmentRoot, directory);
      await mkdir(env[key], { recursive: true });
      if (signal?.aborted) throw new Error("The Vitest test was aborted while preparing an isolated PowerShell environment");
    }
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(environmentRoot, "empty-git-config"), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", NO_UPDATE_NOTIFIER: "1", NPM_CONFIG_USERCONFIG: join(environmentRoot, "empty-npm-user-config"), NPM_CONFIG_GLOBALCONFIG: join(environmentRoot, "empty-npm-global-config") });
    const tracksRuntimeNpm = pathPrefix === undefined && process.platform === "win32" && /(?:\\scripts\\invoke|\\locked-entry)\.ps1$/iu.test(scriptPath);
    if (tracksRuntimeNpm) {
      maximumInheritedPathLength = Math.max(maximumInheritedPathLength, (env.PATH ?? "").length);
      if (runtimeNpmCmd === undefined) {
        const pathSearchStarted = performance.now();
        runtimeNpmCmd = (env.PATH ?? "").split(";").map((directory) => directory.trim().replace(/^"|"$/gu, "")).filter(Boolean).map((directory) => join(directory, "npm.cmd")).find((candidate) => existsSync(candidate));
        npmPathSearchMs += performance.now() - pathSearchStarted;
      }
      if (runtimeNpmCmd === undefined) throw new Error("Could not locate the real npm.cmd in the inherited PATH for launch counting");
      const trackerBin = join(environmentRoot, "npm-tracker");
      npmMarkerPath = join(environmentRoot, "npm-launch.marker");
      await mkdir(trackerBin, { recursive: true });
      await writeFile(join(trackerBin, "npm.cmd"), `@echo off\r\n>>"${npmMarkerPath}" echo invoked\r\ncall "${runtimeNpmCmd}" %*\r\nexit /b %ERRORLEVEL%\r\n`, "utf8");
      env.PATH = `${trackerBin};${env.PATH ?? ""}`;
    }
    if (pathPrefix !== undefined) env.PATH = `${pathPrefix};${env.PATH ?? ""}`;
    powerShellExecutablePath = resolvePowerShellExecutable(env);
    if (modulePathStrategy === "powershell-home-modules") {
      expectedModulePath = join(dirname(powerShellExecutablePath), "Modules");
      if (!existsSync(expectedModulePath)) throw new Error(`PowerShell system Modules directory is missing for ${powerShellExecutablePath}`);
      bootstrapScriptPath = join(environmentRoot, "invoke-with-module-bootstrap.ps1");
      bootstrapEvidencePath = join(environmentRoot, "module-bootstrap-evidence.txt");
      bootstrapArgumentsPath = join(environmentRoot, "bootstrap-arguments.txt");
      await writeFile(bootstrapArgumentsPath, [scriptPath, cwdPath, ...argumentsList]
        .map((value) => Buffer.from(value, "utf8").toString("base64")).join("\r\n"), "ascii");
      await writeFile(bootstrapScriptPath, inProcessModuleBootstrap, "utf8");
    }
    envReadyAt = { at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started) };
    if (signal?.aborted) throw new Error("The Vitest test was aborted before starting a PowerShell invocation");
  } catch (error: unknown) {
    emitBeforeSpawn("pre-spawn-error", error, signal?.aborted ? "owning-test-cancellation" : null);
    throw error;
  }

  if (modulePathStrategy === "powershell-home-modules") {
    const normalizedScriptPath = scriptPath.replaceAll("/", "\\").toLowerCase();
    const targetParameterContract = normalizedScriptPath.endsWith("\\set-runtime-binding.ps1")
      ? "set-runtime-binding"
      : normalizedScriptPath.endsWith("\\wait-tree.ps1") ? "none" : "invoke";
    commandArguments = [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", bootstrapScriptPath!,
      "-DiagnosticId", invocationId,
      "-BootstrapEvidencePath", bootstrapEvidencePath!,
      "-BootstrapArgumentsPath", bootstrapArgumentsPath!,
      "-TargetParameterContract", targetParameterContract,
    ];
  }

  const readBootstrapEvidence = (): ModuleBootstrapEvidence | null => {
    if (bootstrapEvidencePath === null || expectedModulePath === null) return null;
    try {
      const lines = readFileSync(bootstrapEvidencePath, "utf8").split(/\r?\n/);
      if (lines.length !== 8 || lines[0] !== "v1" || lines[1] !== invocationId
        || lines[2] !== "in-process-call-operator" || !["NOT_PROVIDED", "PROVIDED"].includes(lines[3] ?? "")
        || lines[7] !== "MATCH") return null;
      const decode = (value: string | undefined) => Buffer.from(value ?? "", "base64").toString("utf8");
      const modulePathAfter = decode(lines[5]);
      const evidenceExpectedPath = decode(lines[6]);
      if (modulePathAfter.toLowerCase() !== expectedModulePath.toLowerCase()
        || evidenceExpectedPath.toLowerCase() !== expectedModulePath.toLowerCase()) return null;
      return {
        diagnosticId: lines[1],
        invocationMode: "in-process-call-operator",
        modulePathBefore: lines[3] === "NOT_PROVIDED" ? null : decode(lines[4]),
        modulePathAfter,
        expectedModulePath: evidenceExpectedPath,
        verification: "MATCH",
      };
    } catch {
      return null;
    }
  };
  return new Promise((resolve, reject) => {
    const spawnChild = () => {
      try {
        return spawn("powershell.exe", commandArguments, {
          cwd: cwdPath,
          windowsHide: true,
          detached: process.platform !== "win32",
          env,
        });
      } catch (error: unknown) {
        emitBeforeSpawn("spawn-threw", error, null);
        throw error;
      }
    };
    const child = spawnChild();
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    let npmLog = "";
    let npmLogBytes = 0;
    let npmLogPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let npmLogCaptured = false;
    let npmLogCaptureReason: string | null = null;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0, stderrBytes = 0;
    let stdoutPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderrPreview: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stdoutEnded = false, stderrEnded = false;
    let stdoutObserved = false, stderrObserved = false;
    let firstStdoutAt: Readonly<Record<string, unknown>> | null = null;
    let firstStderrAt: Readonly<Record<string, unknown>> | null = null;
    let timeout: NodeJS.Timeout | undefined;
    let closeCode: number | null = null;
    let closed = false;
    let closeProcessed = false;
    let exitObservedAt: Readonly<Record<string, unknown>> | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let timedOut = false;
    let cleanupFinished = false;
    let settled = false;
    let cleanupPromise: Promise<void> | null = null;
    let closeWaiter: { readonly resolve: () => void; readonly reject: (error: Error) => void } | null = null;
    let stopOrigin: string | null = null;
    let stopStartedAt: Readonly<Record<string, unknown>> | null = null;
    let stopCompletedAt: Readonly<Record<string, unknown>> | null = null;
    let stopOutcome: string | null = null;
    let stopError: string | null = null;
    let treeStopObservation: TreeStopObservation | null = null;
    let closeWaitStartedAt: Readonly<Record<string, unknown>> | null = null;
    let closeWaitOutcome: string | null = null;
    let finalDiagnosticEmitted = false;
    let childError: string | null = null;
    const stamp = () => ({ at: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started) });
    const previewChunk = (previous: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> => previous.length >= diagnosticStreamLimit
      ? previous
      : Buffer.concat([previous, chunk.subarray(0, diagnosticStreamLimit - previous.length)]);
    const currentNpmMarkerSnapshot = () => npmMarkerPath === null
      ? { status: "NOT_APPLICABLE", reason: "runtime npm tracking shim was not configured" }
      : npmMarkerSnapshot(npmMarkerPath);
    const diagnosticRecord = (event: string, extra: Readonly<Record<string, unknown>> = {}) => ({
      schemaVersion: 1,
      invocationId,
      stage,
      event,
      startedAt,
      eventAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      command: {
        program: "powershell.exe",
        arguments: { totalCount: commandArguments.length, retained: commandArguments.slice(0, 32).map((argument) => boundedDiagnosticText(argument, 512)), truncated: commandArguments.length > 32 },
        cwd: boundedDiagnosticText(cwdPath),
        timeoutMs: timeoutMs ?? null,
      },
      environmentPrepared: envReadyAt !== null,
      envReadyAt: observedAt(envReadyAt),
      moduleEnvironment: (() => {
        const moduleBootstrapEvidence = readBootstrapEvidence();
        return {
        strategy: modulePathStrategy,
        invocationMode,
        parentPSModulePath: { status: parentPSModulePathStatus, sha256: parentPSModulePathSha256 },
        childPSModulePath: moduleBootstrapEvidence === null
          ? env.PSModulePath === undefined ? { status: "NOT_PROVIDED" } : { status: "PROVIDED", path: env.PSModulePath }
          : { status: "PROVIDED", path: moduleBootstrapEvidence.modulePathAfter },
        bootstrapEvidence: moduleBootstrapEvidence ?? { status: "NOT_CAPTURED" },
        resolvedPowerShellExecutable: powerShellExecutablePath === null ? { status: "NOT_OBSERVED" } : { status: "RESOLVED", path: powerShellExecutablePath },
      };
      })(),
      spawnedAt: observedAt(launchAt),
      rootProcessId: child.pid === undefined ? { status: "NOT OBSERVED" } : { status: "OBSERVED", value: child.pid },
      firstStdoutAt: observedAt(firstStdoutAt),
      firstStderrAt: observedAt(firstStderrAt),
      exit: { observedAt: observedAt(exitObservedAt), code: exitObservedAt === null ? "NOT OBSERVED" : observedExitCode, signal: exitObservedAt === null ? "NOT OBSERVED" : exitSignal },
      close: { observedAt: observedAt(closeAt), code: closed ? closeCode : "NOT OBSERVED", eventObserved: closed, processingComplete: closeProcessed },
      stopRequest: { origin: stopOrigin ?? "NOT OBSERVED", at: observedAt(stopStartedAt) },
      cleanup: {
        stopOutcome: stopOutcome ?? "NOT OBSERVED",
        stopStartedAt: observedAt(stopStartedAt),
        stopCompletedAt: observedAt(stopCompletedAt),
        treeStopObservation: treeStopObservation ?? { status: "NOT OBSERVED" },
        closeWaitStartedAt: observedAt(closeWaitStartedAt),
        closeWaitOutcome: closeWaitOutcome ?? "NOT OBSERVED",
        rootCloseEventObserved: closed,
        error: stopError === null ? { status: "NOT OBSERVED" } : boundedDiagnosticText(stopError),
      },
      owningTestSignalAborted: signal?.aborted ?? false,
      stdout: capturedStreamDiagnostic(stdoutBytes, stdoutPreview, stdoutEnded),
      stderr: capturedStreamDiagnostic(stderrBytes, stderrPreview, stderrEnded),
      npmMarker: currentNpmMarkerSnapshot(),
      childError: childError === null ? { status: "NOT OBSERVED" } : boundedDiagnosticText(childError),
      npmLog: npmLogCaptured ? {
        ...capturedStreamDiagnostic(npmLogBytes, npmLogPreview, true, "original-npm-debug-log-file-buffer-bytes"),
        retainedRange: npmLogPreview.length === 0 ? null : { startByteInclusive: npmLogBytes - npmLogPreview.length, endByteExclusive: npmLogBytes },
        retainedSelection: "tail",
  } : { status: "NOT_CAPTURED", totalOriginalBytes: "NOT OBSERVED", reason: npmLogCaptureReason ?? "NOT OBSERVED" },
      ...extra,
    });
    const emit = (event: string, extra: Readonly<Record<string, unknown>> = {}) => emitProcessDiagnostic(diagnosticRecord(event, extra));
    const emitFinal = (event: string, extra: Readonly<Record<string, unknown>> = {}) => {
      if (finalDiagnosticEmitted) return;
      finalDiagnosticEmitted = true;
      emit(event, extra);
    };
    let launchAt: Readonly<Record<string, unknown>> | null = null;
    let closeAt: Readonly<Record<string, unknown>> | null = null;
    let observedExitCode: number | null = null;
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutObserved = true;
      stdoutBytes += chunk.length;
      stdoutPreview = previewChunk(stdoutPreview, chunk);
      if (firstStdoutAt === null) firstStdoutAt = stamp();
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrObserved = true;
      stderrBytes += chunk.length;
      stderrPreview = previewChunk(stderrPreview, chunk);
      if (firstStderrAt === null) firstStderrAt = stamp();
      stderr += stderrDecoder.write(chunk);
    });
    child.stdout.once("end", () => { stdout += stdoutDecoder.end(); stdoutEnded = true; });
    child.stderr.once("end", () => { stderr += stderrDecoder.end(); stderrEnded = true; });
    const clearProcessState = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      activeTreeStops.delete(stopTree);
    };
    const finish = () => {
      if (settled || !closeProcessed || (timedOut && !cleanupFinished)) return;
      settled = true;
      clearProcessState();
      if (signal?.aborted) {
        const error = new Error("The Vitest test ended while a PowerShell invocation was active");
        emitFinal("final-rejected-after-owning-test-cancellation", { returnedExitCode: closeCode, timedOut, failure: { name: error.name, ...boundedDiagnosticText(error.message) } });
        reject(error);
      } else {
        emitFinal("final-return", { returnedExitCode: closeCode, timedOut });
        const moduleBootstrapEvidence = readBootstrapEvidence();
        resolve({ diagnosticId: invocationId, exitCode: closeCode, stdout, stderr, npmLog, stdoutBytes, stderrBytes, stdoutPreview, stderrPreview, stdoutEnded, stderrEnded, npmLogBytes, npmLogPreview, npmLogCaptured, npmLogCaptureReason, timedOut, powerShellExecutablePath: powerShellExecutablePath!, modulePathStrategy, invocationMode, moduleBootstrapEvidence, parentPSModulePathStatus, parentPSModulePathSha256, childPSModulePath: moduleBootstrapEvidence?.modulePathAfter ?? env.PSModulePath ?? null });
      }
    };
    const waitForClose = () => {
      if (closeProcessed) { closeWaitOutcome = "ROOT_CLOSE_ALREADY_OBSERVED"; return Promise.resolve(); }
      closeWaitStartedAt = stamp();
      return new Promise<void>((resolveClose, rejectClose) => {
        const timer = setTimeout(() => {
          closeWaiter = null;
          closeWaitOutcome = "ROOT_CLOSE_WAIT_TIMED_OUT";
          rejectClose(new Error(`PowerShell process ${child.pid ?? "unknown"} did not close after bounded tree termination`));
        }, 1_500);
        closeWaiter = {
          resolve: () => { clearTimeout(timer); closeWaiter = null; closeWaitOutcome = "ROOT_CLOSE_OBSERVED"; resolveClose(); },
          reject: (error) => { clearTimeout(timer); closeWaiter = null; closeWaitOutcome = "ROOT_CLOSE_WAIT_REJECTED"; rejectClose(error); },
        };
        if (closeProcessed) closeWaiter.resolve();
      });
    };
    const stopTree = (origin: "owning-test-cancellation" | "owned-timeout" | "afterEach" = "afterEach"): Promise<void> => {
      if (cleanupPromise !== null) return cleanupPromise;
      if (child.pid === undefined) {
        const error = new Error("PowerShell process did not expose a PID for bounded tree cleanup");
        stopOrigin = signal?.aborted ? "owning-test-cancellation" : origin;
        stopStartedAt = stamp(); stopOutcome = "ROOT_PID_UNAVAILABLE"; stopError = error.message;
        emit("cleanup-final", { status: "FAILED", outcome: stopOutcome, failure: { name: error.name, ...boundedDiagnosticText(error.message) } });
        emitFinal("final-cleanup-rejected", { failure: { name: boundedDiagnosticText(error.name, 128), ...boundedDiagnosticText(error.message) } });
        return Promise.reject(error);
      }
      timedOut = !signal?.aborted;
      stopOrigin = signal?.aborted ? "owning-test-cancellation" : origin;
      stopStartedAt = stamp();
      emit("stop-requested", { reason: stopOrigin });
      cleanupPromise = (async () => {
        await terminateProcessTree(child.pid!, (observation) => {
          treeStopObservation = observation;
          emit("tree-stop-command-observed", { reason: stopOrigin });
        });
        await waitForClose();
        stopCompletedAt = stamp();
        stopOutcome = closeProcessed ? "TREE_STOP_AND_ROOT_CLOSE_OBSERVED" : "TREE_STOP_RETURNED_ROOT_CLOSE_UNOBSERVED";
        cleanupFinished = true;
        emit("cleanup-final", { status: "COMPLETED", outcome: stopOutcome });
        finish();
      })();
      void cleanupPromise.catch((error: unknown) => {
        stopCompletedAt = stamp();
        stopOutcome ??= "TREE_STOP_OR_ROOT_CLOSE_FAILED";
        stopError = error instanceof Error ? error.message : String(error);
        emit("cleanup-final", { status: "FAILED", failure: error instanceof Error ? { name: boundedDiagnosticText(error.name, 128), ...boundedDiagnosticText(error.message) } : boundedDiagnosticText(String(error)) });
      });
      return cleanupPromise;
    };
    const failCleanup = (error: unknown) => {
      if (settled) return;
      settled = true;
      stopError = error instanceof Error ? error.message : String(error);
      stopOutcome ??= "TREE_STOP_OR_ROOT_CLOSE_FAILED";
      clearProcessState();
      emitFinal("final-cleanup-rejected", { failure: error instanceof Error ? { name: boundedDiagnosticText(error.name, 128), ...boundedDiagnosticText(error.message) } : boundedDiagnosticText(String(error)) });
      reject(error);
    };
    const onAbort = () => { void stopTree("owning-test-cancellation").catch(failCleanup); };
    child.once("spawn", () => {
      launchAt = stamp();
      powershellLaunchCount += 1;
      if (signal?.aborted) {
        void stopTree("owning-test-cancellation").catch(failCleanup);
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      activeTreeStops.add(stopTree);
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          if (!closed) void stopTree("owned-timeout").catch(failCleanup);
        }, timeoutMs);
      }
    });
    child.once("exit", (code, childSignal) => {
      exitObservedAt = stamp(); observedExitCode = code; exitSignal = childSignal;
    });
    child.once("error", (error) => {
      childError = error.message;
      settled = true;
      clearProcessState();
      emitFinal("final-child-error", { failure: { name: boundedDiagnosticText(error.name, 128), ...boundedDiagnosticText(error.message) } });
      reject(error);
    });
    child.once("close", async (exitCode) => {
      closeAt = stamp();
      closeCode = exitCode;
      closed = true;
      const wasAlreadySettled = settled;
      if (npmMarkerPath !== null) {
        const marker = await readFile(npmMarkerPath, "utf8").catch(() => "");
        npmCommandAttemptCount += marker.split(/\r?\n/u).filter((line) => line === "invoked").length;
      }
      const npmLogDirectory = join(environmentRoot!, "npm-cache", "_logs");
      maximumNpmLogPathLength = Math.max(maximumNpmLogPathLength, join(npmLogDirectory, "2026-10-03T00_00_00_000Z-debug-0.log").length);
      let npmLogNames: string[] = [];
      try { npmLogNames = (await readdir(npmLogDirectory)).filter((name) => name.endsWith(".log")).sort(); }
      catch { npmLogCaptureReason = "npm debug log directory could not be read"; }
      if (npmLogNames.length > 0) {
        try {
          const npmLogBuffer = await readFile(join(npmLogDirectory, npmLogNames.at(-1)!));
          npmLogCaptured = true;
          npmLogBytes = npmLogBuffer.length;
          npmLogPreview = npmLogBuffer.subarray(Math.max(0, npmLogBuffer.length - diagnosticStreamLimit));
          npmLog = npmLogBuffer.toString("utf8").slice(-4_000);
        } catch { npmLogCaptureReason = "npm debug log read failed"; }
      } else npmLogCaptureReason ??= "no matching npm debug log file found";
      closeProcessed = true;
      closeWaiter?.resolve();
      if (!timedOut) cleanupFinished = true;
      if (wasAlreadySettled) emit("late-close-after-rejection", { returnedExitCode: closeCode, timedOut });
      else finish();
    });
  });
}

function npmMarkerSnapshot(path: string): Readonly<Record<string, unknown>> {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, "r");
    const totalOriginalBytes = fstatSync(descriptor).size;
    const retainedBuffer = Buffer.alloc(Math.min(totalOriginalBytes, diagnosticStreamLimit));
    const bytesRead = readSync(descriptor, retainedBuffer, 0, retainedBuffer.length, 0);
    const retained = retainedBuffer.subarray(0, bytesRead);
    return {
      status: totalOriginalBytes === 0 ? "CAPTURED_EMPTY" : "CAPTURED",
      byteCountBasis: "original-marker-file-buffer-bytes",
      totalOriginalBytes,
      truncated: totalOriginalBytes > retained.length,
      retainedRange: retained.length === 0 ? null : { startByteInclusive: 0, endByteExclusive: retained.length },
      retainedPrefixBase64: retained.length === 0 ? null : retained.toString("base64"),
      interpretation: "snapshot only; an unavailable/empty marker is not proof npm was not invoked",
    };
  } catch (error: unknown) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : null;
    return { status: "NOT_CAPTURED", errorCode: code === null ? "NOT OBSERVED" : boundedDiagnosticText(code, 128), interpretation: "read failure is not evidence npm was not invoked" };
  } finally {
    if (descriptor !== null) { try { closeSync(descriptor); } catch { /* Snapshot cleanup must not affect invocation control. */ } }
  }
}

function isProcessRunning(processId: number): boolean {
  const result = spawnSync("tasklist.exe", ["/FI", `PID eq ${processId}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  return result.stdout.includes(`,\"${processId}\"`);
}

function processFailure(result: ProcessResult): string {
  return `diagnosticId=${result.diagnosticId}\ntimedOut=${result.timedOut}\nexitCode=${result.exitCode}\nstdout=${JSON.stringify(capturedStreamDiagnostic(result.stdoutBytes, result.stdoutPreview, result.stdoutEnded))}\nstderr=${JSON.stringify(capturedStreamDiagnostic(result.stderrBytes, result.stderrPreview, result.stderrEnded))}\nnpmLog=${JSON.stringify(result.npmLogCaptured ? { ...capturedStreamDiagnostic(result.npmLogBytes, result.npmLogPreview, true, "original-npm-debug-log-file-buffer-bytes"), retainedRange: result.npmLogPreview.length === 0 ? null : { startByteInclusive: result.npmLogBytes - result.npmLogPreview.length, endByteExclusive: result.npmLogBytes }, retainedSelection: "tail" } : { status: "NOT_CAPTURED", totalOriginalBytes: "NOT OBSERVED", reason: result.npmLogCaptureReason ?? "NOT OBSERVED" })}`;
}

function emitCompleteWindowPhase(phase: string, detail: Readonly<Record<string, unknown>> = {}): boolean {
  try { process.stderr.write(`COMPLETE_WINDOW_PHASE ${JSON.stringify({ schemaVersion: 1, phase, at: new Date().toISOString(), ...detail })}\n`); return true; } catch { return false; /* Phase evidence must not alter the test. */ }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function createInvocationMarker(root: string): Promise<{ readonly binPath: string; readonly markerPath: string }> {
  const binPath = join(root, "fake-npm-bin");
  const markerPath = join(root, "npm-invoked.marker");
  await mkdir(binPath);
  await writeFile(join(binPath, "npm.cmd"), `@echo off\r\n> "${markerPath}" echo invoked\r\nexit /b 99\r\n`, "utf8");
  return { binPath, markerPath };
}

async function createBoundInstalledSkill(root: string, runtimeRoot = process.cwd()): Promise<string> {
  const installedSkillPath = join(root, "installed-skill");
  const canonicalSkillPath = join(repositoryRoot, "skills", "custom", "d-ai");
  await mkdir(join(installedSkillPath, "scripts"), { recursive: true });
  await copyFile(join(canonicalSkillPath, "SKILL.md"), join(installedSkillPath, "SKILL.md"));
  await copyFile(join(canonicalSkillPath, "scripts", "invoke.ps1"), join(installedSkillPath, "scripts", "invoke.ps1"));
  await copyFile(join(canonicalSkillPath, "scripts", "set-runtime-binding.ps1"), join(installedSkillPath, "scripts", "set-runtime-binding.ps1"));
  await writeFile(join(installedSkillPath, ".runtime-root"), `${runtimeRoot}\n`, "utf8");
  return installedSkillPath;
}

async function createInstalledSkill(root: string): Promise<string> {
  const installedSkillPath = join(root, "installed-skill");
  const canonicalSkillPath = join(repositoryRoot, "skills", "custom", "d-ai");
  await mkdir(join(installedSkillPath, "scripts"), { recursive: true });
  await copyFile(join(canonicalSkillPath, "SKILL.md"), join(installedSkillPath, "SKILL.md"));
  await copyFile(join(canonicalSkillPath, "scripts", "invoke.ps1"), join(installedSkillPath, "scripts", "invoke.ps1"));
  await copyFile(join(canonicalSkillPath, "scripts", "set-runtime-binding.ps1"), join(installedSkillPath, "scripts", "set-runtime-binding.ps1"));
  return installedSkillPath;
}

async function runGit(workspacePath: string, argumentsList: readonly string[]): Promise<void> {
  try {
    await runCommand({ command: "git", arguments: argumentsList, cwd: workspacePath });
  } catch (error: unknown) {
    if (error instanceof CommandExecutionError) throw new Error(`${error.message}: ${JSON.stringify(error.result)}`);
    throw error;
  }
}

describe.skipIf(process.platform !== "win32")("source-window Skill compatibility", { timeout: 30_000 }, () => {
  it.for(["complete", "partial", "continuation"] as const)("preserves %s windows through Skill, CLI, runtime and fresh recovery", async (mode, { signal }) => {
    const testStarted = performance.now();
    const expectedCompletePhases = ["teststart", "fixturestart", "fixtureend", "inputready", "skillstart", "skillreturn", "persistedcheckstart", "persistedcheckend", "recoverycheckstart", "recoverycheckend", "statusstart", "statusend", "continuestart", "continueend", "fixturecleanupstart", "fixturecleanupend"];
    const observedCompletePhases: string[] = [];
    const phase = (name: string, detail: Readonly<Record<string, unknown>> = {}) => {
      if (mode === "complete" && emitCompleteWindowPhase(name, { elapsedMs: Math.round(performance.now() - testStarted), ...detail })) observedCompletePhases.push(name);
    };
    const emitPhaseSummary = () => {
      if (mode === "complete") emitCompleteWindowPhase("testsummary", {
        elapsedMs: Math.round(performance.now() - testStarted),
        phases: {
          observed: observedCompletePhases,
          missing: expectedCompletePhases.filter((name) => !observedCompletePhases.includes(name)).map((name) => ({ phase: name, status: "NOT OBSERVED" })),
          expectedCount: expectedCompletePhases.length,
          observedCount: observedCompletePhases.length,
        },
      });
    };
    phase("teststart");
    phase("fixturestart");
    let root: string;
    try { root = await mkdtemp(join(tmpdir(), "d-ai-skill-source-positive-")); }
    catch (error: unknown) {
      phase("fixturecreatefailed", { failure: boundedDiagnosticError(error) });
      emitPhaseSummary();
      throw error;
    }
    try {
      const fixture = await sourceWindowFixture(root);
      phase("fixtureend", { taskId: fixture.taskId });
      const durableBefore = await durableContent(join(fixture.workspacePath, ".d-ai"));
      let input = fixture.input;
      if (mode === "continuation") {
        await writeFile(fixture.path, JSON.stringify({ version: 1, sourceWindow: input }));
        const first = await runCodexCLI(sourceWindowCLIArguments(fixture));
        expect(first.exitCode).toBe(0);
        expect(first.response.curationPipeline).toMatchObject({ checkpointAdvanced: true, finalization: { latestCheckpoint: { coveredThroughMarker: "m-004" } } });
        const messages = [{ marker: "m-005", text: "Milestone: continuation verified.", observedAt: "2026-10-03T00:00:04.000Z", memoryId: "window-continuation", subjectKey: "window:continuation" }];
        input = { ...input, messages, sourceStartAttested: false, previousCoveredThroughMarker: input.coveredThroughMarker, previousBoundarySha256: input.boundarySha256, coveredThroughMarker: "m-005", boundarySha256: buildCurationBoundarySha256(input.coveredThroughMarker, input.boundarySha256, messages) };
      } else if (mode === "partial") {
        input = { ...input, coverageConfidence: "partial" };
      }
      await writeFile(fixture.path, JSON.stringify({ version: 1, sourceWindow: input }));
      phase("inputready", { taskId: fixture.taskId });
      let response: CodexActivationResponse;
      if (mode === "complete") {
        phase("skillstart", { taskId: fixture.taskId });
        const result = await runPowerShellArguments(fixture.entryPath, fixture.workspacePath, sourceWindowArguments(fixture, fixture.path), signal, undefined, undefined, "complete-window-skill-entry");
        phase("skillreturn", { taskId: fixture.taskId, diagnosticId: result.diagnosticId, timedOut: result.timedOut, exitCode: result.exitCode });
        expect(result.timedOut).toBe(false);
        expect(result.exitCode, result.stderr + result.stdout).toBe(0);
        response = JSON.parse(result.stdout.trim()) as CodexActivationResponse;
      } else {
        const result = await runCodexCLI(sourceWindowCLIArguments(fixture, fixture.path, mode === "partial" ? "整理一下" : "@D-AI 整理"));
        expect(result.exitCode).toBe(0);
        response = result.response;
      }
      expect(response).toMatchObject({ taskId: fixture.taskId, status: "completed", curationPipeline: { checkpointAdvanced: mode !== "partial", checkpointRecorded: mode !== "partial", safeToDeleteSourceChat: mode === "partial" ? "NO" : "YES" } });

      const reader = new LocalSqliteMemoryStore({ databasePath: fixture.databasePath, workspacePath: dirname(fixture.databasePath), mode: "reader", scopeId: resolveLocalMemoryScopeId(fixture.databasePath), writerId: "primary-device" });
      try {
        phase("persistedcheckstart", { taskId: fixture.taskId });
        const sequences: number[] = [];
        for (const message of input.messages) {
          const record = await reader.get(message.memoryId!);
          expect(record).toMatchObject({ value: { fact: message.text, projectTaskId: fixture.taskId, provenance: { sourceCheckpoint: input.boundarySha256 } } });
          sequences.push(record!.sequence);
        }
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        phase("persistedcheckend", { taskId: fixture.taskId });
        phase("recoverycheckstart", { taskId: fixture.taskId });
        const recovery = await createCurationPipeline({ store: reader, workspacePath: dirname(fixture.databasePath), repositoryPath: fixture.workspacePath }).recover(fixture.taskId, input.sourceType, input.sourceKey);
        if (mode === "partial") {
          expect(recovery).toMatchObject({ status: "empty", checkpoint: null, currentView: null, viewFresh: false });
        } else {
          expect(recovery).toMatchObject({ status: "available", viewFresh: true, projectTaskId: fixture.taskId, checkpoint: { sourceType: input.sourceType, sourceKeySha256: hashCurationSourceKey(input.sourceKey), coveredThroughMarker: input.coveredThroughMarker, boundarySha256: input.boundarySha256, coverageConfidence: input.coverageConfidence, projectTaskId: fixture.taskId }, currentView: { verificationStatus: "verified" } });
          for (const message of input.messages) expect(recovery.currentView?.relevantMemoryIds).toContain(message.memoryId);
        }
        phase("recoverycheckend", { taskId: fixture.taskId });
      } finally { reader.close(); }

      phase("statusstart", { taskId: fixture.taskId });
      const status = await runCodexCLI(["--workspace", fixture.workspacePath, "--command", "@D-AI status", "--task", fixture.taskId, "--memory-database", fixture.databasePath]);
      expect(status.exitCode).toBe(0);
      expect(status.response).toMatchObject({ taskId: fixture.taskId, memorySnapshot: { status: "available" } });
      phase("statusend", { taskId: fixture.taskId, exitCode: status.exitCode });
      if (mode !== "partial") {
        phase("continuestart", { taskId: fixture.taskId });
        const continued = await runCodexCLI(["--workspace", fixture.workspacePath, "--command", "@D-AI continue", "--task", fixture.taskId, "--memory-database", fixture.databasePath]);
        expect(continued.exitCode).toBe(0);
        expect(continued.response).toMatchObject({ taskId: fixture.taskId, bossSession: { recoveryCompleteness: { status: "COMPLETE" } } });
        phase("continueend", { taskId: fixture.taskId, exitCode: continued.exitCode });
      }
      expect(await durableContent(join(fixture.workspacePath, ".d-ai"))).toEqual(durableBefore);
    } finally {
      phase("fixturecleanupstart");
      let cleanupOutcome = "NOT OBSERVED";
      let cleanupFailure: Readonly<Record<string, unknown>> | null = null;
      try { await rm(root, { recursive: true, force: true }); cleanupOutcome = "COMPLETED"; }
      catch (error: unknown) { cleanupOutcome = "FAILED"; cleanupFailure = boundedDiagnosticError(error); throw error; }
      finally {
        phase("fixturecleanupend", { outcome: cleanupOutcome, ...(cleanupFailure === null ? {} : { failure: cleanupFailure }) });
        emitPhaseSummary();
      }
    }
  });

  it.for(["missing", "relative", "unreadable", "oversize", "UTF8", "JSON", "envelope", "extra-envelope-key", "structure", "empty-messages", "too-many-messages", "marker", "previous-boundary", "boundary-format", "digest", "order", "task", "message-task", "coverage", "combined", "fresh-digest", "fresh-order"])("rejects %s without changing memory, checkpoint or durable-task content", async (kind, { signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-skill-source-negative-"));
    try {
      const fixture = await sourceWindowFixture(root);
      await writeFile(fixture.path, JSON.stringify({ version: 1, sourceWindow: fixture.input }));
      if (!kind.startsWith("fresh-") && kind !== "extra-envelope-key") {
        const seed = await runCodexCLI(["--workspace", fixture.workspacePath, "--command", "@D-AI 整理", "--task", fixture.taskId, "--curation-source-window", fixture.path, "--memory-database", fixture.databasePath]);
        expect(seed.exitCode, JSON.stringify(seed.response)).toBe(0);
      }
      const before = await curationContent(fixture.workspacePath, fixture.databasePath);
      let windowPath = fixture.path;
      let entryPath = fixture.entryPath;
      let sourceWindow: unknown = fixture.input;
      switch (kind) {
        case "missing": windowPath = join(root, "missing.json"); break;
        case "relative": windowPath = "source-window.json"; break;
        case "unreadable": {
          entryPath = join(root, "locked-entry.ps1");
          const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
          await writeFile(entryPath, "$held = [System.IO.File]::Open(" + quote(fixture.path) + ", [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)\ntry { & " + quote(fixture.entryPath) + " @args; exit $LASTEXITCODE } finally { $held.Dispose() }\n");
          break;
        }
        case "oversize": await writeFile(fixture.path, Buffer.alloc(1024 * 1024 + 1, 32)); break;
        case "UTF8": await writeFile(fixture.path, Buffer.from([0xc3, 0x28])); break;
        case "JSON": await writeFile(fixture.path, "{PRIVATE-FIXTURE-CONTENT"); break;
        case "envelope": await writeFile(fixture.path, '{"version":2,"sourceWindow":{}}'); break;
        case "extra-envelope-key": await writeFile(fixture.path, JSON.stringify({ version: 1, sourceWindow: fixture.input, extra: true })); break;
        case "structure": sourceWindow = { ...fixture.input, messages: "not-an-array" }; break;
        case "empty-messages": sourceWindow = { ...fixture.input, messages: [] }; break;
        case "too-many-messages": sourceWindow = { ...fixture.input, messages: Array.from({ length: 65 }, () => fixture.input.messages[0]) }; break;
        case "marker": sourceWindow = { ...fixture.input, messages: [{ ...fixture.input.messages[0], marker: "" }] }; break;
        case "previous-boundary": sourceWindow = { ...fixture.input, previousBoundarySha256: "0".repeat(64) }; break;
        case "boundary-format": sourceWindow = { ...fixture.input, boundarySha256: "invalid" }; break;
        case "digest": case "fresh-digest": sourceWindow = { ...fixture.input, boundarySha256: "0".repeat(64) }; break;
        case "order": case "fresh-order": {
          const messages = [...fixture.input.messages].reverse();
          sourceWindow = { ...fixture.input, messages, coveredThroughMarker: messages.at(-1)!.marker, boundarySha256: buildCurationBoundarySha256(null, null, messages) };
          break;
        }
        case "task": sourceWindow = { ...fixture.input, projectTaskId: "task-other-project" }; break;
        case "message-task": {
          const messages = [{ ...fixture.input.messages[0]!, projectTaskId: "task-other-project" }];
          sourceWindow = { ...fixture.input, messages, coveredThroughMarker: messages[0]!.marker, boundarySha256: buildCurationBoundarySha256(null, null, messages) };
          break;
        }
        case "coverage": sourceWindow = { ...fixture.input, coverageConfidence: "invalid" }; break;
      }
      if (sourceWindow !== fixture.input) await writeFile(fixture.path, JSON.stringify({ version: 1, sourceWindow }));
      const cliArgs = sourceWindowCLIArguments(fixture, windowPath);
      const skillArgs = sourceWindowArguments(fixture, windowPath);
      if (kind === "combined") {
        const payload = join(root, "payload.json");
        await writeFile(payload, JSON.stringify({ version: 1, candidates: [] }));
        skillArgs.push("-CurationPayloadPath", payload);
      }
      let response: CodexActivationResponse | null = null;
      if (kind === "combined") {
        const { binPath, markerPath } = await createInvocationMarker(root);
        const result = await runPowerShellArguments(fixture.entryPath, fixture.workspacePath, skillArgs, signal, binPath);
        expect(result.timedOut).toBe(false);
        expect(result.exitCode, result.stderr + result.stdout).toBe(2);
        response = parseSkillStdout(result);
        expect(await pathExists(markerPath)).toBe(false);
      } else if (kind === "structure") {
        const result = await runPowerShellArguments(fixture.entryPath, fixture.workspacePath, skillArgs, signal);
        expect(result.timedOut).toBe(false);
        expect(result.exitCode, result.stderr + result.stdout).toBe(2);
        expect(result.stdout.trim()).not.toBe("");
        console.log(`SKILL_SOURCE_STRUCTURE_STREAMS ${JSON.stringify({ stdout: result.stdout, stderr: result.stderr })}`);
        response = parseSkillStdout(result);
        expect(result.stderr).not.toContain("PRIVATE-FIXTURE-CONTENT");
      } else if (kind === "unreadable") {
        const result = await runPowerShellArguments(entryPath, fixture.workspacePath, skillArgs, signal);
        expect(result.timedOut).toBe(false);
        expect(result.exitCode, result.stderr + result.stdout).toBe(2);
        response = parseSkillStdout(result);
      } else if (kind === "relative") {
        await expect(runCodexCLI(cliArgs)).rejects.toThrow(/source-window path must be absolute/i);
      } else {
        const result = await runCodexCLI(cliArgs);
        expect(result.exitCode).toBe(2);
        response = result.response;
      }
      const after = await curationContent(fixture.workspacePath, fixture.databasePath);
      expect(after).toEqual(before);
      if (response !== null) expect(response.status).toBe("blocked");
      if (response !== null && (kind.endsWith("digest") || kind.endsWith("order"))) {
        expect(response.curationPipeline).toMatchObject({ status: "blocked", checkpointAdvanced: false, checkpointRecorded: false, checkpoint: null, currentView: null, relatedMemoryCount: 0, finalization: { reason: "Source-chat finalization is blocked; source chat deletion remains NO" } });
      }
      if (kind === "extra-envelope-key") expect(await pathExists(fixture.databasePath)).toBe(false);
      if (kind.startsWith("fresh-")) {
        const database = new DatabaseSync(fixture.databasePath, { readOnly: true });
        try {
          expect(database.prepare("SELECT count(*) AS n FROM memory_scopes").get()?.n).toBe(1);
        } finally { database.close(); }
        expect(after.records).toHaveLength(0);
        expect(after.checkpoints).toHaveLength(0);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe.skipIf(process.platform !== "win32")("test-only PowerShell process cleanup", () => {
  it("rejects an invocation already cancelled by its owning test without spawning PowerShell", async ({ signal }) => {
    const cancelled = new AbortController();
    cancelled.abort();
    const launchesBefore = powershellLaunchCount;
    await expect(runPowerShellArguments("not-started.ps1", process.cwd(), [], cancelled.signal)).rejects.toThrow(/aborted before starting/i);
    expect(powershellLaunchCount).toBe(launchesBefore);
    expect(signal.aborted).toBe(false);
  });

  it("terminates a controlled descendant tree before returning a timed-out invocation", { timeout: 10_000 }, async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-process-tree-cleanup-"));
    const scriptPath = join(root, "wait-tree.ps1");
    const moduleEnvironmentPath = join(root, "module-environment.txt");
    const quotedModuleEnvironmentPath = moduleEnvironmentPath.replace(/'/gu, "''");
    const moduleEnvironmentReadLimit = 4 * 1024;
    const parentPSModulePath = process.env.PSModulePath;
    const parentPSModulePathStatus = parentPSModulePath === undefined ? "NOT_PROVIDED" : "PROVIDED";
    const parentPSModulePathSha256 = parentPSModulePath === undefined ? null : createHash("sha256").update(parentPSModulePath, "utf8").digest("hex");
    let result: ProcessResult | undefined;
    let invocationOutcome: "RETURNED" | "REJECTED" = "REJECTED";
    let moduleEnvironmentReadState: "CAPTURED" | "MISSING" | "UNREADABLE" | "MALFORMED" | "PARTIAL" = "MISSING";
    let moduleEnvironmentFileBytesBeforeRead: number | null = null;
    let moduleEnvironmentFileBytesAfterRead: number | null = null;
    let moduleEnvironmentReadBytes: number | null = null;
    let moduleEnvironmentRetainedBytes: number | null = null;
    let moduleEnvironmentReadComplete: boolean | null = null;
    let moduleEnvironmentRecordComplete: boolean | null = null;
    let moduleEnvironmentTruncated: boolean | null = null;
    let actualExecutable: string | null = null;
    let actualPowerShellHome: string | null = null;
    let actualPSModulePath: string | null = null;
    await writeFile(scriptPath, [
      `[System.IO.File]::WriteAllLines('${quotedModuleEnvironmentPath}', [string[]]@([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName, $PSHOME, $env:PSModulePath), [System.Text.UTF8Encoding]::new($false))`,
      "$child = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 60' -PassThru -WindowStyle Hidden",
      'Write-Output "TEST_CHILD_PID=$($child.Id)"',
      "Wait-Process -Id $child.Id",
    ].join("\r\n"), "utf8");
    try {
      try {
        result = await runPowerShellArguments(scriptPath, root, [], signal, undefined, 5_000);
        invocationOutcome = "RETURNED";
      } catch (error: unknown) {
        invocationOutcome = "REJECTED";
        throw error;
      } finally {
        try {
          const descriptor = openSync(moduleEnvironmentPath, "r");
          try {
            moduleEnvironmentFileBytesBeforeRead = fstatSync(descriptor).size;
            const boundedBuffer = Buffer.alloc(moduleEnvironmentReadLimit + 1);
            moduleEnvironmentReadBytes = readSync(descriptor, boundedBuffer, 0, boundedBuffer.length, 0);
            moduleEnvironmentFileBytesAfterRead = fstatSync(descriptor).size;
            moduleEnvironmentRetainedBytes = Math.min(moduleEnvironmentReadBytes, moduleEnvironmentReadLimit);
            moduleEnvironmentTruncated = moduleEnvironmentFileBytesBeforeRead > moduleEnvironmentReadLimit
              || moduleEnvironmentFileBytesAfterRead > moduleEnvironmentReadLimit
              || moduleEnvironmentReadBytes > moduleEnvironmentReadLimit;
            moduleEnvironmentReadComplete = !moduleEnvironmentTruncated
              && moduleEnvironmentFileBytesBeforeRead === moduleEnvironmentFileBytesAfterRead
              && moduleEnvironmentReadBytes === moduleEnvironmentFileBytesAfterRead;

            if (!moduleEnvironmentReadComplete) {
              moduleEnvironmentReadState = "PARTIAL";
              moduleEnvironmentRecordComplete = false;
            } else {
              moduleEnvironmentRecordComplete = false;
              let decodedEnvironment: string | null = null;
              try {
                decodedEnvironment = new TextDecoder("utf-8", { fatal: true }).decode(boundedBuffer.subarray(0, moduleEnvironmentRetainedBytes));
              } catch {
                moduleEnvironmentReadState = "MALFORMED";
              }
              if (decodedEnvironment !== null) {
                const lines = decodedEnvironment.split(/\r?\n/u);
                const hasFinalLineTerminator = decodedEnvironment.endsWith("\n");
                if (hasFinalLineTerminator && lines.at(-1) === "") lines.pop();
                if (!hasFinalLineTerminator) {
                  moduleEnvironmentReadState = "MALFORMED";
                } else if (lines.length !== 3) {
                  moduleEnvironmentReadState = "MALFORMED";
                } else {
                  actualExecutable = lines[0] ?? null;
                  actualPowerShellHome = lines[1] ?? null;
                  actualPSModulePath = lines[2] ?? null;
                  if (lines.some((line) => line.trim().length === 0)) {
                    moduleEnvironmentReadState = "MALFORMED";
                  } else {
                    moduleEnvironmentReadState = "CAPTURED";
                    moduleEnvironmentRecordComplete = true;
                  }
                }
              }
            }
          } finally {
            closeSync(descriptor);
          }
        } catch (error: unknown) {
          moduleEnvironmentReadState = (error as NodeJS.ErrnoException).code === "ENOENT" ? "MISSING" : "UNREADABLE";
        }

        try {
          console.log(`PR64_NORMAL_POWERSHELL_MODULE_ENV ${JSON.stringify({
            test: "controlled descendant timeout cleanup",
            policy: "powershell-home-modules; verify executable, PSHOME, and supplied Modules entry",
            invocation: {
              outcome: invocationOutcome,
              returned: result !== undefined,
              rejected: invocationOutcome === "REJECTED",
              diagnosticId: result === undefined ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: result.diagnosticId },
              exitCode: result === undefined ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: result.exitCode },
              timedOut: result === undefined ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: result.timedOut },
              signalAborted: signal.aborted,
            },
            parentPSModulePath: { status: parentPSModulePathStatus, sha256: parentPSModulePathSha256 },
            childProvidedModulesPath: result === undefined
              ? { status: "NOT_OBSERVED" }
              : result.childPSModulePath === null
                ? { status: "NOT_PROVIDED" }
                : { status: "PROVIDED", path: result.childPSModulePath },
            moduleEnvironmentFile: {
              readState: moduleEnvironmentReadState,
              fileBytesBeforeRead: moduleEnvironmentFileBytesBeforeRead === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: moduleEnvironmentFileBytesBeforeRead },
              fileBytesAfterRead: moduleEnvironmentFileBytesAfterRead === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: moduleEnvironmentFileBytesAfterRead },
              readBytes: moduleEnvironmentReadBytes === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: moduleEnvironmentReadBytes },
              retainedBytes: moduleEnvironmentRetainedBytes === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: moduleEnvironmentRetainedBytes },
              allFileBytesRead: moduleEnvironmentReadComplete === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: moduleEnvironmentReadComplete },
              recordComplete: moduleEnvironmentRecordComplete === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: moduleEnvironmentRecordComplete },
              truncated: moduleEnvironmentTruncated === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: moduleEnvironmentTruncated },
              executable: actualExecutable === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", path: actualExecutable },
              powerShellHome: actualPowerShellHome === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", path: actualPowerShellHome },
              actualPSModulePath: actualPSModulePath === null ? { status: "NOT_OBSERVED" } : { status: "OBSERVED", value: actualPSModulePath },
            },
          })}`);
        } catch {
          // Evidence output must not replace an invocation or cleanup error.
        }
      }
      if (result === undefined) throw new Error("PowerShell helper returned without a process result");
      expect(result.timedOut).toBe(true);
      const childPid = Number(result.stdout.match(/TEST_CHILD_PID=(\d+)/u)?.[1]);
      expect(Number.isInteger(childPid), `${result.stdout}\n${result.stderr}`).toBe(true);
      expect(childPid).toBeGreaterThan(0);
      expect(isProcessRunning(childPid)).toBe(false);
      expect(moduleEnvironmentReadState).toBe("CAPTURED");
      const normalizedPath = (value: string) => value.replace(/[\\/]+$/gu, "").replace(/\//gu, "\\").toLowerCase();
      expect(actualExecutable).not.toBeNull();
      expect(actualPowerShellHome).not.toBeNull();
      expect(actualPSModulePath).not.toBeNull();
      expect(normalizedPath(actualExecutable!)).toBe(normalizedPath(result.powerShellExecutablePath));
      expect(normalizedPath(actualPowerShellHome!)).toBe(normalizedPath(dirname(actualExecutable!)));
      const actualModuleEntries = actualPSModulePath!.split(";").map((entry) => normalizedPath(entry.trim())).filter(Boolean);
      expect(actualModuleEntries).toContain(normalizedPath(result.childPSModulePath!));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "win32")("normal PowerShell in-process module bootstrap", { timeout: 30_000 }, () => {
  it("preserves the Skill string-parameter contract, script context, module evidence, and target exit outcomes", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-powershell-bootstrap-contract-"));
    const scriptDirectory = join(root, "target path 中文 'quoted' & $semi; [x]");
    const workspacePath = join(root, "workspace 空格 中文 'single' & $semi; [x]");
    const cwdPath = join(root, "cwd 空格 中文 'single' & $semi; [x]");
    const scriptPath = join(scriptDirectory, "invoke.ps1");
    const injectionMarker = join(root, "must-not-be-created.txt");
    const sourceInvokePath = join(repositoryRoot, "skills", "custom", "d-ai", "scripts", "invoke.ps1");
    const sourceInvokeSha256Before = createHash("sha256").update(await readFile(sourceInvokePath)).digest("hex");
    const commandText = `literal data: spaces 中文 "double" 'single' $env:PATH ; & | ^ \`n [System.IO.File]::WriteAllText('${injectionMarker.replaceAll("'", "''")}', 'executed')`;
    const namedArguments = [
      "-CommandText", commandText,
      "-TaskId", `task 中文 "double" 'single' $x; & | ^`,
      "-WorkspacePath", workspacePath,
      "-CurationPayloadPath", join(root, "payload path 中文 'single' & $semi;.json"),
      "-CurationSourceWindowPath", join(root, "source path 中文 'single' & $semi;.json"),
      "-MemoryDatabasePath", join(root, "database path 中文 'single' & $semi;.sqlite"),
      "-TaskCharterFile", join(root, "charter path 中文 'single' & $semi;.json"),
      "-ApproveTaskCharterDigest", "digest 中文 \"quoted\" 'single' $x; & | ^",
    ];
    const fixtureScript = [
      "[CmdletBinding()]",
      "param(",
      "  [Parameter(Mandatory = $true)][string]$CommandText,",
      "  [Parameter(Mandatory = $false)][string]$TaskId,",
      "  [Parameter(Mandatory = $false)][string]$WorkspacePath = (Get-Location).Path,",
      "  [Parameter(Mandatory = $false)][string]$CurationPayloadPath,",
      "  [Parameter(Mandatory = $false)][string]$CurationSourceWindowPath,",
      "  [Parameter(Mandatory = $false)][string]$MemoryDatabasePath,",
      "  [Parameter(Mandatory = $false)][string]$TaskCharterFile,",
      "  [Parameter(Mandatory = $false)][string]$ApproveTaskCharterDigest",
      ")",
      "if ($CommandText -eq '__EXIT_ZERO__') { exit 0 }",
      "if ($CommandText -eq '__EXIT_TWO__') { exit 2 }",
      "if ($CommandText -eq '__THROW__') { throw 'bootstrap contract fixture failure' }",
      "if ($CommandText -eq '__NATURAL_STALE_EXIT__') { $global:LASTEXITCODE = 73 }",
      "if ($CommandText -eq '__STDERR__') { [System.Console]::Error.WriteLine('bootstrap stderr contract marker') }",
      "if ($CommandText -eq '__WARNING__') { Write-Warning 'bootstrap unfiltered warning contract marker' }",
      "[Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes(([ordered]@{ commandText = $CommandText; taskId = $TaskId; workspacePath = $WorkspacePath; curationPayloadPath = $CurationPayloadPath; curationSourceWindowPath = $CurationSourceWindowPath; memoryDatabasePath = $MemoryDatabasePath; taskCharterFile = $TaskCharterFile; approveTaskCharterDigest = $ApproveTaskCharterDigest; workingDirectory = (Get-Location).Path; scriptRoot = $PSScriptRoot } | ConvertTo-Json -Compress))))",
    ].join("\r\n");

    try {
      await Promise.all([mkdir(scriptDirectory), mkdir(workspacePath), mkdir(cwdPath)]);
      await writeFile(scriptPath, fixtureScript, "utf8");
      const fixtureSha256 = createHash("sha256").update(await readFile(scriptPath)).digest("hex");
      const result = await runPowerShellArguments(scriptPath, cwdPath, namedArguments, signal);
      expect(result.exitCode, processFailure(result)).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.invocationMode).toBe("in-process-bootstrap");
      expect(result.moduleBootstrapEvidence).toMatchObject({
        diagnosticId: result.diagnosticId,
        invocationMode: "in-process-call-operator",
        modulePathAfter: join(dirname(result.powerShellExecutablePath), "Modules"),
        expectedModulePath: join(dirname(result.powerShellExecutablePath), "Modules"),
        verification: "MATCH",
      });
      expect(result.childPSModulePath).toBe(result.moduleBootstrapEvidence?.modulePathAfter);
      expect(result.stderr).toBe("");
      expect(JSON.parse(Buffer.from(result.stdout.trim(), "base64").toString("utf8"))).toEqual({
        commandText,
        taskId: namedArguments[3],
        workspacePath,
        curationPayloadPath: namedArguments[7],
        curationSourceWindowPath: namedArguments[9],
        memoryDatabasePath: namedArguments[11],
        taskCharterFile: namedArguments[13],
        approveTaskCharterDigest: namedArguments[15],
        workingDirectory: cwdPath,
        scriptRoot: scriptDirectory,
      });
      expect(await pathExists(injectionMarker)).toBe(false);
      expect(createHash("sha256").update(await readFile(scriptPath)).digest("hex")).toBe(fixtureSha256);
      expect(createHash("sha256").update(await readFile(sourceInvokePath)).digest("hex")).toBe(sourceInvokeSha256Before);

      for (const outcome of [
        { commandText: "__EXIT_ZERO__", expectedExitCode: 0, expectedStderr: "" },
        { commandText: "__EXIT_TWO__", expectedExitCode: 2, expectedStderr: "" },
        { commandText: "__NATURAL_STALE_EXIT__", expectedExitCode: 0, expectedStderr: "" },
        { commandText: "__STDERR__", expectedExitCode: 0, expectedStderr: /bootstrap stderr contract marker/, expectedStdoutAbsent: "bootstrap stderr contract marker" },
        { commandText: "__WARNING__", expectedExitCode: 0, expectedStderr: "", expectedStreamMarker: "bootstrap unfiltered warning contract marker" },
        { commandText: "__THROW__", expectedExitCode: 1, expectedStderr: /bootstrap contract fixture failure/ },
      ]) {
        const outcomeResult = await runPowerShellArguments(scriptPath, cwdPath, ["-CommandText", outcome.commandText], signal);
        expect(outcomeResult.exitCode, processFailure(outcomeResult)).toBe(outcome.expectedExitCode);
        expect(outcomeResult.timedOut).toBe(false);
        expect(outcomeResult.invocationMode).toBe("in-process-bootstrap");
        expect(outcomeResult.moduleBootstrapEvidence).toMatchObject({
          diagnosticId: outcomeResult.diagnosticId,
          invocationMode: "in-process-call-operator",
          verification: "MATCH",
        });
        if (typeof outcome.expectedStderr === "string") expect(outcomeResult.stderr).toBe(outcome.expectedStderr);
        else expect(outcomeResult.stderr).toMatch(outcome.expectedStderr);
        if ("expectedStdoutAbsent" in outcome) expect(outcomeResult.stdout).not.toContain(outcome.expectedStdoutAbsent);
        if ("expectedStreamMarker" in outcome) expect(`${outcomeResult.stdout}\n${outcomeResult.stderr}`).toContain(outcome.expectedStreamMarker);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function sourceWindowFor(taskId: string): CurationPipelineInput {
  const messages = [
    { marker: "m-001", text: "Milestone: source-window adapter verified.", observedAt: "2026-10-03T00:00:00.000Z", memoryId: "window-milestone", subjectKey: "window:milestone" },
    { marker: "m-002", text: "Current blocker: synthetic dependency unavailable.", observedAt: "2026-10-03T00:00:01.000Z", memoryId: "window-blocker", subjectKey: "window:blocker" },
    { marker: "m-003", text: "Next action: review the adapter.", observedAt: "2026-10-03T00:00:02.000Z", memoryId: "window-next", subjectKey: "window:next" },
    { marker: "m-004", text: "Current phase: compatibility verification", observedAt: "2026-10-03T00:00:03.000Z", memoryId: "window-phase", subjectKey: "window:phase" },
  ];
  return { sourceType: "conversation", sourceKey: "skill-source-window", projectTaskId: taskId, messages, previousCoveredThroughMarker: null, previousBoundarySha256: null, sourceStartAttested: true, coveredThroughMarker: "m-004", boundarySha256: buildCurationBoundarySha256(null, null, messages), coverageConfidence: "complete", finalWindow: true, trigger: "source-delete-check" };
}

async function durableContent(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  if (!await pathExists(root)) return result;
  async function walk(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const key = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(path, entry.name), `${key}/`);
      else result[key] = createHash("sha256").update(await readFile(join(path, entry.name))).digest("hex");
    }
  }
  await walk(root, "");
  return result;
}

async function curationContent(workspacePath: string, databasePath: string) {
  const durable = await durableContent(join(workspacePath, ".d-ai"));
  if (!await pathExists(databasePath)) return { durable, records: [], checkpoints: [] };
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    // Initialization metadata is permitted; compare all persisted fact and checkpoint content.
    return { durable, records: database.prepare("SELECT * FROM memory_records ORDER BY 1").all(), checkpoints: database.prepare("SELECT * FROM curation_checkpoints ORDER BY 1").all() };
  } finally { database.close(); }
}

async function sourceWindowFixture(root: string) {
  const workspacePath = join(root, "workspace");
  const databasePath = join(root, "memory.sqlite");
  await mkdir(workspacePath);
  const entryPath = join(await createBoundInstalledSkill(root, repositoryRoot), "scripts", "invoke.ps1");
  const established = await runCodexCLI(["--workspace", workspacePath, "--command", "@D-AI establish source-window fixture", "--memory-database", databasePath]);
  expect(established.response.status).toBe("accepted");
  const taskId = established.response.taskId;
  expect((await new FileDurableContextStore(join(workspacePath, ".d-ai")).load(taskId))?.taskId).toBe(taskId);
  const path = join(root, "source-window.json");
  return { workspacePath, databasePath, entryPath, taskId, path, input: sourceWindowFor(taskId) };
}

function sourceWindowArguments(fixture: Awaited<ReturnType<typeof sourceWindowFixture>>, path = fixture.path, command = "@D-AI 整理"): string[] {
  return ["-WorkspacePath", fixture.workspacePath, "-CommandText", command, "-TaskId", fixture.taskId, "-CurationSourceWindowPath", path, "-MemoryDatabasePath", fixture.databasePath];
}

function sourceWindowCLIArguments(fixture: Awaited<ReturnType<typeof sourceWindowFixture>>, path = fixture.path, command = "@D-AI 整理"): string[] {
  return ["--workspace", fixture.workspacePath, "--command", command, "--task", fixture.taskId, "--curation-source-window", path, "--memory-database", fixture.databasePath];
}

function parseSkillStdout(result: ProcessResult): CodexActivationResponse {
  return JSON.parse(result.stdout.trim()) as CodexActivationResponse;
}

describe.skipIf(process.platform !== "win32")("D-AI Codex Skill PowerShell product boundary", { timeout: 20_000 }, () => {
  it("uses the explicit binding from D-AI-Hub, Quote Float-like, and unrelated CWDs", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-cwds-"));
    const installedSkillPath = await createBoundInstalledSkill(root);
    const dAiHubCwd = join(root, "D-AI-Hub");
    const quoteFloatCwd = join(root, "Quote Float");
    const unrelatedCwd = join(root, "unrelated");
    try {
      await Promise.all([mkdir(dAiHubCwd), mkdir(quoteFloatCwd), mkdir(unrelatedCwd)]);
      const cwdWorkspacePairs: readonly (readonly [string, string])[] = [[dAiHubCwd, dAiHubCwd], [quoteFloatCwd, quoteFloatCwd], [unrelatedCwd, unrelatedCwd]];
      for (const [cwd, workspacePath] of cwdWorkspacePairs) {
        const args = ["-WorkspacePath", workspacePath, "-CommandText", "@D-AI close"];
        const result = await runPowerShellArguments(join(installedSkillPath, "scripts", "invoke.ps1"), cwd, args, signal);
        expect(result.exitCode, processFailure(result)).toBe(2);
        const response = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(response.message).toMatch(/No active D-AI task matches this workspace/i);
        expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before runtime invocation for missing, stale, invalid, relative, and drive-relative bindings", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-binding-failure-"));
    const installedSkillPath = await createInstalledSkill(root);
    const workspacePath = join(root, "workspace");
    const invalidRuntimePath = join(root, "invalid-runtime");
    const { binPath, markerPath } = await createInvocationMarker(root);
    try {
      await mkdir(workspacePath);
      await mkdir(invalidRuntimePath);
      const drive = root.slice(0, 2);
      for (const binding of [null, join(root, "missing-runtime"), invalidRuntimePath, ".", `${drive}relative-runtime`]) {
        if (binding === null) {
          await rm(join(installedSkillPath, ".runtime-root"), { force: true });
        } else {
          await writeFile(join(installedSkillPath, ".runtime-root"), `${binding}\n`, "utf8");
        }
        const result = await runPowerShellArguments(join(installedSkillPath, "scripts", "invoke.ps1"), workspacePath, ["-WorkspacePath", workspacePath, "-CommandText", "@D-AI status"], signal, binPath);
        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(2);
        const response = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(response).toMatchObject({ taskId: "unassigned", environment: "codex", status: "blocked", stage: "bootstrap" });
        expect(response.message).toMatch(/binding|runtime root/i);
        expect(await pathExists(markerPath)).toBe(false);
        expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
        expect(await new FileDurableContextStore(join(workspacePath, ".d-ai")).discoverActiveTasks(workspacePath)).toHaveLength(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("creates, idempotently preserves, and updates a validated runtime binding", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-binding-tool-"));
    const installedSkillPath = await createInstalledSkill(root);
    const runtimeRoot = process.cwd();
    const secondRuntimeRoot = join(root, "second-runtime");
    try {
      await mkdir(join(secondRuntimeRoot, "src", "entry"), { recursive: true });
      await copyFile(join(runtimeRoot, "package.json"), join(secondRuntimeRoot, "package.json"));
      await copyFile(join(runtimeRoot, "src", "entry", "codex-cli.ts"), join(secondRuntimeRoot, "src", "entry", "codex-cli.ts"));
      const setScript = join(installedSkillPath, "scripts", "set-runtime-binding.ps1");
      const invoke = (target: string) => runPowerShellArguments(setScript, root, ["-SkillRoot", installedSkillPath, "-RuntimeRoot", target], signal);

      const created = await invoke(runtimeRoot);
      expect(created.exitCode, `${created.stderr}\n${created.stdout}`).toBe(0);
      expect(JSON.parse(created.stdout)).toMatchObject({ status: "created", runtimeRoot });
      await expect(readFile(join(installedSkillPath, ".runtime-root"), "utf8")).resolves.toBe(`${runtimeRoot}\r\n`);

      const unchanged = await invoke(runtimeRoot);
      expect(unchanged.exitCode, `${unchanged.stderr}\n${unchanged.stdout}`).toBe(0);
      expect(JSON.parse(unchanged.stdout)).toMatchObject({ status: "unchanged", runtimeRoot });

      const updated = await invoke(secondRuntimeRoot);
      expect(updated.exitCode, `${updated.stderr}\n${updated.stdout}`).toBe(0);
      expect(JSON.parse(updated.stdout)).toMatchObject({ status: "updated", runtimeRoot: secondRuntimeRoot });
      await expect(readFile(join(installedSkillPath, ".runtime-root"), "utf8")).resolves.toBe(`${secondRuntimeRoot}\r\n`);

      for (const mistypedSkillRoot of [join(root, "Quote Float"), join(root, "user-workspace")]) {
        await mkdir(mistypedSkillRoot);
        const result = await runPowerShellArguments(setScript, root, ["-SkillRoot", mistypedSkillRoot, "-RuntimeRoot", secondRuntimeRoot], signal);
        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(1);
        expect(result.stderr).toMatch(/Installed D-AI Skill root|SKILL\.md/i);
        expect(await pathExists(join(mistypedSkillRoot, ".runtime-root"))).toBe(false);
      }

      const invalid = join(root, "invalid-runtime");
      await mkdir(invalid);
      const rejected = await invoke(invalid);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stderr).toMatch(/package\.json|Runtime root is invalid/i);
      await expect(readFile(join(installedSkillPath, ".runtime-root"), "utf8")).resolves.toBe(`${secondRuntimeRoot}\r\n`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers the Skill and sends a raw close command into the configured runtime from an unrelated workspace", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-e2e-"));
    const workspacePath = join(root, "unrelated-workspace");
    try {
      await mkdir(workspacePath);
      const entryPath = join(await createBoundInstalledSkill(root), "scripts", "invoke.ps1");

      const result = await runPowerShell(entryPath, workspacePath, "@D-AI close", signal);

      expect(result.exitCode, processFailure(result)).toBe(2);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ taskId: "unassigned", environment: "codex", status: "blocked" });
      expect(response.message).toMatch(/No active D-AI task matches this workspace.*--task <task-id>/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps generic intent read-only when a configured Codex workspace is local-only", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-connector-"));
    const workspacePath = join(root, "unrelated-workspace");
    const executionSkillPath = join(repositoryRoot, "tests", "fixtures", "skills", "typescript-execution");
    try {
      await mkdir(workspacePath);
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await symlink(executionSkillPath, join(workspacePath, ".agents", "skills", "typescript-execution"), "junction");
      const entryPath = join(await createBoundInstalledSkill(root), "scripts", "invoke.ps1");

      const result = await runPowerShell(entryPath, workspacePath, "@D-AI implement typescript", signal);

      expect(result.exitCode, result.stderr).toBe(2);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ taskId: "unassigned", environment: "codex", status: "blocked", stage: "bootstrap" });
      expect(response.message).toMatch(/No active local-only D-AI task matches this workspace/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks a generic explicit verify intent through the public Skill when no active task exists", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-real-execution-"));
    const workspacePath = join(root, "workspace");
    const verificationSkillPath = join(workspacePath, ".agents", "skills", "verify-local");
    try {
      await mkdir(verificationSkillPath, { recursive: true });
      await writeFile(join(verificationSkillPath, "SKILL.md"), `---\nname: verify-local\ndescription: Bounded local verification\nmetadata:\n  triggers: '["verify"]'\n  compatibleEnvironments: '["codex"]'\n  compatibleStages: '["execute"]'\n---\n\n# Bounded local verification\n`, "utf8");
      await writeFile(join(workspacePath, "fixture.txt"), "safe fixture\n", "utf8");
      await runGit(workspacePath, ["init", "-b", "main"]);
      await runGit(workspacePath, ["config", "user.email", "d-ai-test@example.invalid"]);
      await runGit(workspacePath, ["config", "user.name", "D-AI Test"]);
      await runGit(workspacePath, ["add", "."]);
      await runGit(workspacePath, ["commit", "-m", "test: bounded verification fixture"]);
      await runGit(workspacePath, ["branch", "-m", "verify/review"]);
      await runGit(workspacePath, ["remote", "add", "origin", "https://github.com/acme/d-ai.git"]);

      const entryPath = join(await createBoundInstalledSkill(root), "scripts", "invoke.ps1");
      const result = await runPowerShell(entryPath, workspacePath, "@D-AI verify local workspace", signal);

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(2);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ environment: "codex", status: "blocked", stage: "bootstrap", taskId: "unassigned" });
      expect(response.message).toMatch(/No active D-AI task matches this canonical workspace and repository.*establish/i);
      expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unsupported remotes at the public Skill execution boundary", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-unsupported-remote-"));
    const workspacePath = join(root, "workspace");
    const verificationSkillPath = join(workspacePath, ".agents", "skills", "verify-local");
    const bareRemotePath = join(root, "remote.git");
    try {
      await mkdir(verificationSkillPath, { recursive: true });
      await writeFile(join(verificationSkillPath, "SKILL.md"), `---\nname: verify-local\ndescription: Bounded local verification\nmetadata:\n  triggers: '["verify"]'\n  compatibleEnvironments: '["codex"]'\n  compatibleStages: '["execute"]'\n---\n\n# Bounded local verification\n`, "utf8");
      await writeFile(join(workspacePath, "fixture.txt"), "safe fixture\n", "utf8");
      await runGit(workspacePath, ["init", "-b", "main"]);
      await runGit(workspacePath, ["config", "user.email", "d-ai-test@example.invalid"]);
      await runGit(workspacePath, ["config", "user.name", "D-AI Test"]);
      await runGit(workspacePath, ["add", "."]);
      await runGit(workspacePath, ["commit", "-m", "test: unsupported remote fixture"]);
      await mkdir(bareRemotePath);
      await runGit(bareRemotePath, ["init", "--bare"]);
      await runGit(workspacePath, ["remote", "add", "origin", bareRemotePath]);
      const entryPath = join(await createBoundInstalledSkill(root), "scripts", "invoke.ps1");
      const result = await runPowerShell(entryPath, workspacePath, "@D-AI verify local workspace", signal);

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(2);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ taskId: "unassigned", environment: "codex", status: "blocked", stage: "bootstrap" });
      expect(response.message).toMatch(/Configured Codex.*GitHub.*identity|origin/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the actual installed Skill curation seam with an isolated database and SAFE NO without a payload", async ({ signal }) => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-curation-"));
    const workspacePath = join(root, "workspace");
    const payloadPath = join(root, "curation.json");
    const databasePath = join(root, "memory.sqlite");
    try {
      await mkdir(workspacePath);
      const installedEntry = join(await createBoundInstalledSkill(root), "scripts", "invoke.ps1");
      await writeFile(payloadPath, JSON.stringify({
        version: 1,
        candidates: [{
          candidateId: "installed-skill-fact",
          memoryId: "installed-skill-fact",
          fact: "The installed Skill passes selected facts through an isolated local seam.",
          category: "knowledge",
          source: "current-context",
          privacyRisk: "local-private",
        }],
      }), "utf8");
      const stored = await runPowerShellArguments(installedEntry, workspacePath, [
        "-WorkspacePath", workspacePath,
        "-CommandText", "整理一下",
        "-CurationPayloadPath", payloadPath,
        "-MemoryDatabasePath", databasePath,
      ], signal);
      expect(stored.exitCode, `${stored.stderr}\n${stored.stdout}`).toBe(0);
      expect(JSON.parse(stored.stdout)).toMatchObject({ status: "completed" });
      expect(stored.stdout).toMatch(/Added=1|locally stored=YES/i);

      const reader = new LocalSqliteMemoryStore({ databasePath, workspacePath: dirname(databasePath), mode: "reader", scopeId: resolveLocalMemoryScopeId(databasePath), writerId: "primary-device" });
      try {
        await expect(reader.get("installed-skill-fact")).resolves.not.toBeNull();
      } finally {
        reader.close();
      }
      expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);

      const safeNo = await runPowerShellArguments(installedEntry, workspacePath, [
        "-WorkspacePath", workspacePath,
        "-CommandText", "@D-AI 整理",
      ], signal);
      expect(safeNo.exitCode, `${safeNo.stderr}\n${safeNo.stdout}`).toBe(2);
      expect(JSON.parse(safeNo.stdout)).toMatchObject({ status: "blocked" });
      expect(safeNo.stdout).toMatch(/SAFE TO DELETE ORIGINAL CHAT: NO|not captured/i);
      expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("PR64 minimal PowerShell differential candidate", () => {
  const pairRoot = join(tmpdir(), `d-ai-pr64-minimal-differential-${randomUUID()}`);
  const workspacePath = join(pairRoot, "workspace");
  const payloadPath = join(pairRoot, "synthetic-payload.json");
  const sourceWindowPath = join(pairRoot, "synthetic-source-window.json");
  const memoryDatabasePath = join(pairRoot, "synthetic-memory.sqlite");
  const fakeNpmBinPath = join(pairRoot, "fake-npm-bin");
  const businessArguments = [
    "-WorkspacePath", workspacePath,
    "-CommandText", "@D-AI differential control",
    "-CurationPayloadPath", payloadPath,
    "-CurationSourceWindowPath", sourceWindowPath,
    "-MemoryDatabasePath", memoryDatabasePath,
  ];
  const directControlOutput = '{"status":"direct-control"}';
  const blockedWrapperOutput = '{"status":"blocked","taskId":"unassigned","environment":"codex","stage":"bootstrap","message":"Curation payload and source-window paths cannot be combined"}';
  const fixedHeadInvokeNormalizedSha256 = "05e6fdc9379d20c3c08f166f1a8ca755b3af6d29ff145ad024df9919ae748bd4";
  const controlMetadata = {
    owningTestTimeoutMs: 30_000,
    helperTimeoutMs: null,
    order: "after existing file cases; not a cold-start benchmark",
    comparisonScope: "same harness policy; not original CI byte identity",
    afterEachTimingScope: "body-end to onTestFinished lifecycle boundary; not isolated hook duration",
    npmSentinelLimit: "marker absence is an observation only; it does not alone prove this sentinel or npm was never invoked",
  };
  const directControlScript = [
    "[CmdletBinding()]",
    "param(",
    "  [Parameter(Mandatory = $true)]",
    "  [string]$CommandText,",
    "  [Parameter(Mandatory = $false)]",
    "  [string]$TaskId,",
    "  [Parameter(Mandatory = $false)]",
    "  [string]$WorkspacePath,",
    "  [Parameter(Mandatory = $false)]",
    "  [string]$CurationPayloadPath,",
    "  [Parameter(Mandatory = $false)]",
    "  [string]$CurationSourceWindowPath,",
    "  [Parameter(Mandatory = $false)]",
    "  [string]$MemoryDatabasePath,",
    "  [Parameter(Mandatory = $false)]",
    "  [string]$TaskCharterFile,",
    "  [Parameter(Mandatory = $false)]",
    "  [string]$ApproveTaskCharterDigest",
    ")",
    "[Console]::Out.WriteLine('{\"status\":\"direct-control\"}')",
    "exit 0",
    "",
  ].join("\r\n");
  let firstCaseGateOpen = false;
  let firstCaseGateReason = "first direct control has not completed its test lifecycle";
  let firstCaseTask: { readonly result?: { readonly state?: string } } | undefined;

  it("runs the direct no-data control", { timeout: 30_000, retry: 0, repeats: 0 }, async (context) => {
    if (process.platform !== "win32" || process.version !== "v26.7.0") {
      const reason = process.platform !== "win32" ? `platform=${process.platform}` : `node=${process.version}`;
      console.log(`PR64_MINIMAL_DIFFERENTIAL_NOT_APPLICABLE ${JSON.stringify({ case: "direct", reason })}`);
      context.skip(`NOT APPLICABLE: requires Windows and Node v26.7.0; ${reason}`);
    }

    let preparationMs: number | null = null;
    let invocationMs: number | null = null;
    let fixtureCleanupMs: number | null = null;
    let bodyEndedAt: number | null = null;
    let fixtureCleanupCompleted = false;
    let directCallVerified = false;
    let fixtureRootCreated = false;
    context.onTestFinished(({ task }) => {
      firstCaseTask = task;
      const taskState = task.result?.state ?? "unknown";
      firstCaseGateOpen = directCallVerified && fixtureCleanupCompleted && !context.signal.aborted && taskState === "pass";
      firstCaseGateReason = firstCaseGateOpen
        ? "direct control, capture, fixture cleanup, and applicable afterEach lifecycle passed"
        : `gate closed: task=${taskState}; callVerified=${directCallVerified}; fixtureCleanup=${fixtureCleanupCompleted}; signalAborted=${context.signal.aborted}`;
      console.log(`PR64_MINIMAL_DIFFERENTIAL_DIAGNOSTIC ${JSON.stringify({
        case: "direct",
        taskState,
        status: firstCaseGateOpen ? "PASS" : "GATE_CLOSED",
        preparationMs,
        invocationMs,
        fixtureCleanupMs,
        bodyEndToTestFinishedBoundaryMs: bodyEndedAt === null ? null : Math.round(performance.now() - bodyEndedAt),
        afterEachLifecycle: taskState === "pass" ? "PASSED" : "FAILED_OR_UNVERIFIED",
        gateReason: firstCaseGateReason,
        control: controlMetadata,
      })}`);
    });

    try {
      const preparationStartedAt = performance.now();
      let marker: Awaited<ReturnType<typeof createInvocationMarker>>;
      try {
        await mkdir(pairRoot);
        fixtureRootCreated = true;
        await mkdir(workspacePath);
        marker = await createInvocationMarker(pairRoot);
        expect(marker.binPath).toBe(fakeNpmBinPath);
        await writeFile(join(pairRoot, "direct-control.ps1"), directControlScript, "utf8");
      } finally {
        preparationMs = Math.round(performance.now() - preparationStartedAt);
      }

      const invocationStartedAt = performance.now();
      let result: ProcessResult;
      try {
        result = await runPowerShellArguments(join(pairRoot, "direct-control.ps1"), workspacePath, businessArguments, context.signal, marker.binPath, undefined, "pr64-minimal-differential", "legacy-unset");
      } finally {
        invocationMs = Math.round(performance.now() - invocationStartedAt);
      }
      expect(result.timedOut).toBe(false);
      expect(result.modulePathStrategy).toBe("legacy-unset");
      expect(result.childPSModulePath).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe(directControlOutput);
      expect(result.stderr).toBe("");
      expect(result.stdoutBytes).toBeGreaterThan(0);
      expect(result.stderrBytes).toBe(0);
      expect(result.stdoutPreview.length).toBe(result.stdoutBytes);
      expect(result.stderrPreview.length).toBe(result.stderrBytes);
      expect(result.stdoutEnded).toBe(true);
      expect(result.stderrEnded).toBe(true);
      expect(context.signal.aborted).toBe(false);
      expect(await pathExists(marker.markerPath)).toBe(false);
      expect(await pathExists(payloadPath)).toBe(false);
      expect(await pathExists(sourceWindowPath)).toBe(false);
      expect(await pathExists(memoryDatabasePath)).toBe(false);
      expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
      expect(await pathExists(join(pairRoot, "installed-skill", ".runtime-root"))).toBe(false);
      directCallVerified = true;
    } finally {
      const cleanupStartedAt = performance.now();
      try {
        if (fixtureRootCreated) await rm(pairRoot, { recursive: true, force: true });
        fixtureCleanupCompleted = true;
      } finally {
        fixtureCleanupMs = Math.round(performance.now() - cleanupStartedAt);
        bodyEndedAt = performance.now();
      }
    }
  });

  it("rejects simultaneous synthetic inputs through the unchanged public wrapper", { timeout: 30_000, retry: 0, repeats: 0 }, async (context) => {
    if (process.platform !== "win32" || process.version !== "v26.7.0") {
      const reason = process.platform !== "win32" ? `platform=${process.platform}` : `node=${process.version}`;
      console.log(`PR64_MINIMAL_DIFFERENTIAL_NOT_APPLICABLE ${JSON.stringify({ case: "wrapper", reason })}`);
      context.skip(`NOT APPLICABLE: requires Windows and Node v26.7.0; ${reason}`);
    }
    if (!firstCaseGateOpen || firstCaseTask?.result?.state !== "pass") {
      const reason = firstCaseTask?.result?.state === "pass" ? firstCaseGateReason : `${firstCaseGateReason}; final first-task state=${firstCaseTask?.result?.state ?? "NOT OBSERVED"}`;
      console.log(`PR64_MINIMAL_DIFFERENTIAL_NOTRUN ${JSON.stringify({ case: "wrapper", reason })}`);
      context.skip(`NOT RUN: ${reason}`);
    }

    let preparationMs: number | null = null;
    let invocationMs: number | null = null;
    let fixtureCleanupMs: number | null = null;
    let bodyEndedAt: number | null = null;
    let fixtureCleanupCompleted = false;
    let wrapperCallVerified = false;
    let fixtureRootCreated = false;
    context.onTestFinished(({ task }) => {
      const taskState = task.result?.state ?? "unknown";
      console.log(`PR64_MINIMAL_DIFFERENTIAL_DIAGNOSTIC ${JSON.stringify({
        case: "wrapper",
        taskState,
        status: wrapperCallVerified && fixtureCleanupCompleted && !context.signal.aborted && taskState === "pass" ? "PASS" : "FAILED_OR_UNVERIFIED",
        preparationMs,
        invocationMs,
        fixtureCleanupMs,
        bodyEndToTestFinishedBoundaryMs: bodyEndedAt === null ? null : Math.round(performance.now() - bodyEndedAt),
        afterEachLifecycle: taskState === "pass" ? "PASSED" : "FAILED_OR_UNVERIFIED",
        signalAborted: context.signal.aborted,
        fixtureCleanupCompleted,
        control: controlMetadata,
      })}`);
    });

    try {
      const preparationStartedAt = performance.now();
      let marker: Awaited<ReturnType<typeof createInvocationMarker>>;
      const installedEntry = join(pairRoot, "installed-skill", "scripts", "invoke.ps1");
      try {
        await mkdir(pairRoot);
        fixtureRootCreated = true;
        await mkdir(workspacePath);
        marker = await createInvocationMarker(pairRoot);
        expect(marker.binPath).toBe(fakeNpmBinPath);
        const sourcePath = join(repositoryRoot, "skills", "custom", "d-ai", "scripts", "invoke.ps1");
        await mkdir(dirname(installedEntry), { recursive: true });
        const sourceContent = await readFile(sourcePath);
        await copyFile(sourcePath, installedEntry);
        const copiedContent = await readFile(installedEntry);
        const sourceCopySha256 = createHash("sha256").update(sourceContent).digest("hex");
        const copiedSha256 = createHash("sha256").update(copiedContent).digest("hex");
        const normalizedSourceSha256 = createHash("sha256").update(sourceContent.toString("utf8").replace(/\r\n/gu, "\n")).digest("hex");
        const normalizedCopySha256 = createHash("sha256").update(copiedContent.toString("utf8").replace(/\r\n/gu, "\n")).digest("hex");
        expect(copiedSha256).toBe(sourceCopySha256);
        expect(normalizedSourceSha256).toBe(fixedHeadInvokeNormalizedSha256);
        expect(normalizedCopySha256).toBe(fixedHeadInvokeNormalizedSha256);
      } finally {
        preparationMs = Math.round(performance.now() - preparationStartedAt);
      }

      const invocationStartedAt = performance.now();
      let result: ProcessResult;
      try {
        result = await runPowerShellArguments(installedEntry, workspacePath, businessArguments, context.signal, marker.binPath, undefined, "pr64-minimal-differential", "legacy-unset");
      } finally {
        invocationMs = Math.round(performance.now() - invocationStartedAt);
      }
      expect(result.timedOut).toBe(false);
      expect(result.modulePathStrategy).toBe("legacy-unset");
      expect(result.childPSModulePath).toBeNull();
      expect(result.exitCode).toBe(2);
      expect(result.stdout.trim()).toBe(blockedWrapperOutput);
      expect(result.stderr).toBe("");
      expect(result.stdoutBytes).toBeGreaterThan(0);
      expect(result.stderrBytes).toBe(0);
      expect(result.stdoutPreview.length).toBe(result.stdoutBytes);
      expect(result.stderrPreview.length).toBe(result.stderrBytes);
      expect(result.stdoutEnded).toBe(true);
      expect(result.stderrEnded).toBe(true);
      expect(context.signal.aborted).toBe(false);
      expect(await pathExists(marker.markerPath)).toBe(false);
      expect(await pathExists(payloadPath)).toBe(false);
      expect(await pathExists(sourceWindowPath)).toBe(false);
      expect(await pathExists(memoryDatabasePath)).toBe(false);
      expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
      expect(await pathExists(join(pairRoot, "installed-skill", ".runtime-root"))).toBe(false);
      wrapperCallVerified = true;
    } finally {
      const cleanupStartedAt = performance.now();
      try {
        if (fixtureRootCreated) await rm(pairRoot, { recursive: true, force: true });
        fixtureCleanupCompleted = true;
      } finally {
        fixtureCleanupMs = Math.round(performance.now() - cleanupStartedAt);
        bodyEndedAt = performance.now();
      }
    }
  });
});

describe("PR64 module search path differential", () => {
  const cases = [
    { name: "baseline", setsPsModulePath: false },
    { name: "treatment", setsPsModulePath: true },
  ] as const;
  const fixedHeadInvokeNormalizedSha256 = "05e6fdc9379d20c3c08f166f1a8ca755b3af6d29ff145ad024df9919ae748bd4";
  const blockedWrapperOutput = '{"status":"blocked","taskId":"unassigned","environment":"codex","stage":"bootstrap","message":"Curation payload and source-window paths cannot be combined"}';
  const expectedBlockedOutput = `${blockedWrapperOutput}\r\n`;
  const expectedMarkerLabels = [
    "script-entry",
    "split-parent-before",
    "split-parent-after",
    "curation-before",
    "bootstrap-catch",
    "json-serialization-before",
    "json-serialization-after",
  ];
  let baselineGateOpen = false;
  let baselineGateReason = "baseline case has not completed";
  let baselineSetup: { readonly before: string; readonly after: string; readonly psHome: string; readonly target: string } | undefined;
  let baselineModule: { readonly command: string; readonly source: string; readonly name: string; readonly path: string } | undefined;
  let baselineComparableScript: string | undefined;
  let evidenceRoot: string | undefined;

  for (const localizationCase of cases) {
    it(`${localizationCase.name} preserves the no-data blocked path and captures the module-search differential`, { timeout: 30_000, retry: 0, repeats: 0 }, async (context) => {
      if (process.platform !== "win32" || process.version !== "v26.7.0") {
        const reason = process.platform !== "win32" ? `platform=${process.platform}` : `node=${process.version}`;
        console.log(`PR64_MODULE_DIFFERENTIAL_NOT_APPLICABLE ${JSON.stringify({ case: localizationCase.name, reason })}`);
        context.skip(`NOT APPLICABLE: requires Windows and Node v26.7.0; ${reason}`);
      }
      if (localizationCase.setsPsModulePath && !baselineGateOpen) {
        console.log(`PR64_MODULE_DIFFERENTIAL_NOTRUN ${JSON.stringify({ case: localizationCase.name, reason: baselineGateReason })}`);
        context.skip(`NOT RUN: ${baselineGateReason}`);
      }

      const root = join(tmpdir(), `d-ai-pr64-module-differential-${localizationCase.name}-${randomUUID()}`);
      const workspacePath = join(root, "workspace");
      const payloadPath = join(root, "synthetic-payload.json");
      const sourceWindowPath = join(root, "synthetic-source-window.json");
      const memoryDatabasePath = join(root, "synthetic-memory.sqlite");
      const businessArguments = [
        "-WorkspacePath", workspacePath,
        "-CommandText", "@D-AI differential control",
        "-CurationPayloadPath", payloadPath,
        "-CurationSourceWindowPath", sourceWindowPath,
        "-MemoryDatabasePath", memoryDatabasePath,
      ];
      let fixtureRootCreated = false;
      let fixtureCleanupCompleted = false;
      let evidenceCaseRoot = "NOT CREATED";
      let callVerified = false;

      const marker = (label: string) => `[Console]::Error.WriteLine('PR64_WRAPPER_PATH_MARKER ${label} {0} {1} {2}', $__pr64PathClock.ElapsedTicks, [System.Diagnostics.Stopwatch]::Frequency, [System.DateTimeOffset]::UtcNow.ToString('O'))`;
      const prelude = [
        `$__pr64ApplyModulePathTreatment = ${localizationCase.setsPsModulePath ? "$true" : "$false"}`,
        "$__pr64ModulePathBefore = [string]$env:PSModulePath",
        "$__pr64PowerShellHome = [string]$PSHOME",
        "$__pr64PshomeModules = [System.IO.Path]::Combine($__pr64PowerShellHome, 'Modules')",
        "$__pr64PshomeModulesExists = [System.IO.Directory]::Exists($__pr64PshomeModules)",
        "if (-not $__pr64PshomeModulesExists) { throw 'PowerShell system Modules directory is missing' }",
        "if ($__pr64ApplyModulePathTreatment) { $env:PSModulePath = $__pr64PshomeModules }",
        "$__pr64ModulePathAfter = [string]$env:PSModulePath",
        "$__pr64ModulePathBeforeToken = if ([string]::IsNullOrEmpty($__pr64ModulePathBefore)) { '-' } else { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__pr64ModulePathBefore)) }",
        "$__pr64ModulePathAfterToken = if ([string]::IsNullOrEmpty($__pr64ModulePathAfter)) { '-' } else { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__pr64ModulePathAfter)) }",
        "$__pr64PowerShellHomeToken = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__pr64PowerShellHome))",
        "$__pr64PshomeModulesToken = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__pr64PshomeModules))",
        "$__pr64PshomeModulesExistsText = if ($__pr64PshomeModulesExists) { 'true' } else { 'false' }",
        "[System.Console]::Error.WriteLine('PR64_MODULE_CONTEXT setup {0} {1} {2} {3} {4}', $__pr64ModulePathBeforeToken, $__pr64ModulePathAfterToken, $__pr64PowerShellHomeToken, $__pr64PshomeModulesToken, $__pr64PshomeModulesExistsText)",
      ].join("\n");
      const moduleObserver = [
        "  try {",
        "    $__pr64SplitCommand = Get-Command Split-Path -ErrorAction Stop",
        "    $__pr64SplitModuleName = [string]$__pr64SplitCommand.ModuleName",
        "    $__pr64SplitModule = Get-Module -Name $__pr64SplitModuleName",
        "    $__pr64SplitModulePath = if ($null -eq $__pr64SplitModule) { '' } else { [string]$__pr64SplitModule.Path }",
        "    $__pr64SplitCommandToken = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$__pr64SplitCommand.Name))",
        "    $__pr64SplitSourceToken = if ([string]::IsNullOrEmpty([string]$__pr64SplitCommand.Source)) { '-' } else { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$__pr64SplitCommand.Source)) }",
        "    $__pr64SplitModuleNameToken = if ([string]::IsNullOrEmpty($__pr64SplitModuleName)) { '-' } else { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__pr64SplitModuleName)) }",
        "    $__pr64SplitModulePathToken = if ([string]::IsNullOrEmpty($__pr64SplitModulePath)) { '-' } else { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__pr64SplitModulePath)) }",
        "    $__pr64SplitModuleLoaded = if ($null -eq $__pr64SplitModule) { 'false' } else { 'true' }",
        "    [System.Console]::Error.WriteLine('PR64_MODULE_CONTEXT module {0} {1} {2} {3} {4}', $__pr64SplitCommandToken, $__pr64SplitSourceToken, $__pr64SplitModuleNameToken, $__pr64SplitModulePathToken, $__pr64SplitModuleLoaded)",
        "  } catch {",
        "    $__pr64ModuleObserverError = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($_.Exception.Message))",
        "    [System.Console]::Error.WriteLine('PR64_MODULE_CONTEXT observer-error {0}', $__pr64ModuleObserverError)",
        "  }",
      ].join("\n");
      const replacements: Array<{ readonly label: string; readonly needle: string; readonly replacement: string }> = [
        {
          label: "process-local-module-path-preamble-and-stopwatch-start",
          needle: "$ErrorActionPreference = 'Stop'",
          replacement: `${prelude}\n$__pr64PathClock = [System.Diagnostics.Stopwatch]::StartNew()\n${marker("script-entry")}\n$ErrorActionPreference = 'Stop'`,
        },
        {
          label: "split-parent-before",
          needle: "$skillRoot = Split-Path -Parent $PSScriptRoot",
          replacement: `${marker("split-parent-before")}\n$skillRoot = Split-Path -Parent $PSScriptRoot`,
        },
        {
          label: "split-parent-after",
          needle: "$repositoryRoot = $null",
          replacement: `${marker("split-parent-after")}\n$repositoryRoot = $null`,
        },
        {
          label: "curation-before",
          needle: "  Assert-CurationInputs",
          replacement: `  ${marker("curation-before")}\n  Assert-CurationInputs`,
        },
        {
          label: "bootstrap-catch",
          needle: "  Write-Blocked $_.Exception.Message",
          replacement: `  ${marker("bootstrap-catch")}\n  Write-Blocked $_.Exception.Message`,
        },
        {
          label: "blocked-json-serialization-boundaries",
          needle: [
            "function Write-Blocked([string]$Message) {",
            "  [Console]::Out.WriteLine((([ordered]@{",
            "        status = 'blocked'",
            "        taskId = 'unassigned'",
            "        environment = 'codex'",
            "        stage = 'bootstrap'",
            "        message = $Message",
            "      } | ConvertTo-Json -Compress)))",
            "}",
          ].join("\n"),
          replacement: [
            "function Write-Blocked([string]$Message) {",
            `  ${marker("json-serialization-before")}`,
            "  $__pr64BlockedJson = (([ordered]@{",
            "        status = 'blocked'",
            "        taskId = 'unassigned'",
            "        environment = 'codex'",
            "        stage = 'bootstrap'",
            "        message = $Message",
            "      } | ConvertTo-Json -Compress))",
            `  ${marker("json-serialization-after")}`,
            "  [Console]::Out.WriteLine($__pr64BlockedJson)",
            "}",
          ].join("\n"),
        },
        {
          label: "post-marker-module-source-observer",
          needle: "  exit 2",
          replacement: `${moduleObserver}\n  exit 2`,
        },
      ];

      context.onTestFinished(({ task }) => {
        if (localizationCase.name === "baseline") {
          baselineGateOpen = callVerified && fixtureCleanupCompleted && !context.signal.aborted && task.result?.state === "pass";
          baselineGateReason = baselineGateOpen
            ? "baseline call, exact output/context, fixture cleanup, and applicable afterEach lifecycle passed"
            : `baseline gate closed: task=${task.result?.state ?? "unknown"}; callVerified=${callVerified}; fixtureCleanup=${fixtureCleanupCompleted}; signalAborted=${context.signal.aborted}`;
        }
        console.log(`PR64_MODULE_DIFFERENTIAL_DIAGNOSTIC ${JSON.stringify({
          case: localizationCase.name,
          taskState: task.result?.state ?? "unknown",
          status: localizationCase.name === "baseline" ? (baselineGateOpen ? "PASS" : "GATE_CLOSED") : (callVerified && fixtureCleanupCompleted && task.result?.state === "pass" ? "PASS" : "FAILED_OR_UNVERIFIED"),
          fixtureCleanupCompleted,
          evidenceRoot: evidenceCaseRoot,
          baselineGateReason: localizationCase.name === "baseline" ? baselineGateReason : undefined,
        })}`);
      });

      try {
        await mkdir(root);
        fixtureRootCreated = true;
        await mkdir(workspacePath);
        if (evidenceRoot === undefined) {
          const configuredEvidenceRoot = process.env.PR64_WRAPPER_LOCALIZATION_EVIDENCE_ROOT;
          if (configuredEvidenceRoot !== undefined) {
            if (await pathExists(configuredEvidenceRoot)) throw new Error(`Evidence folder already exists; refusing overwrite: ${configuredEvidenceRoot}`);
            evidenceRoot = configuredEvidenceRoot;
            await mkdir(evidenceRoot);
          } else {
            evidenceRoot = await mkdtemp(join(tmpdir(), "pr64-module-differential-"));
          }
        }
        evidenceCaseRoot = join(evidenceRoot, localizationCase.name);
        await mkdir(evidenceCaseRoot);

        const sourcePath = join(repositoryRoot, "skills", "custom", "d-ai", "scripts", "invoke.ps1");
        const sourceBytes = await readFile(sourcePath);
        const sourceText = sourceBytes.toString("utf8");
        const normalizedSource = sourceText.replace(/\r\n/gu, "\n");
        const sourceNormalizedSha256 = createHash("sha256").update(normalizedSource).digest("hex");
        expect(sourceNormalizedSha256).toBe(fixedHeadInvokeNormalizedSha256);

        let instrumented = normalizedSource;
        const diffSections: string[] = [];
        for (const replacement of replacements) {
          const occurrences = instrumented.split(replacement.needle).length - 1;
          expect(occurrences, `instrumentation needle count for ${replacement.label}`).toBe(1);
          instrumented = instrumented.replace(replacement.needle, replacement.replacement);
          diffSections.push(`@@ ${replacement.label} @@\n-${replacement.needle}\n+${replacement.replacement}`);
        }
        const newline = sourceText.includes("\r\n") ? "\r\n" : "\n";
        const instrumentedText = instrumented.replace(/\n/gu, newline);
        const instrumentedSha256 = createHash("sha256").update(instrumentedText, "utf8").digest("hex");
        const comparableScript = instrumentedText.replace(
          `$__pr64ApplyModulePathTreatment = ${localizationCase.setsPsModulePath ? "$true" : "$false"}`,
          "$__pr64ApplyModulePathTreatment = <TREATMENT_FLAG>",
        );
        if (localizationCase.name === "baseline") baselineComparableScript = comparableScript;
        else expect(comparableScript).toBe(baselineComparableScript);
        const installedEntry = join(root, "installed-skill", "scripts", "invoke.ps1");
        await mkdir(dirname(installedEntry), { recursive: true });
        await writeFile(installedEntry, instrumentedText, "utf8");
        await writeFile(join(evidenceCaseRoot, "generated-wrapper.diff"), `${diffSections.join("\n\n")}\n`, { encoding: "utf8", flag: "wx" });
        await writeFile(join(evidenceCaseRoot, "instrumented-invoke.ps1"), instrumentedText, { encoding: "utf8", flag: "wx" });

        const invocationMarker = await createInvocationMarker(root);
        expect(invocationMarker.binPath).toBe(join(root, "fake-npm-bin"));
        const helperCallStartedAtUtc = new Date().toISOString();
        const result = await runPowerShellArguments(
          installedEntry,
          workspacePath,
          businessArguments,
          context.signal,
          invocationMarker.binPath,
          undefined,
          `pr64-module-differential-${localizationCase.name}`,
          "legacy-unset",
        );
        const helperCallCompletedAtUtc = new Date().toISOString();

        await writeFile(join(evidenceCaseRoot, "stdout.raw.log"), result.stdout, { encoding: "utf8", flag: "wx" });
        await writeFile(join(evidenceCaseRoot, "stderr.raw.log"), result.stderr, { encoding: "utf8", flag: "wx" });
        const stderrLines = result.stderr.replace(/\r?\n$/u, "").split(/\r?\n/u);
        expect(stderrLines).toHaveLength(expectedMarkerLabels.length + 2);
        const setupMatch = /^PR64_MODULE_CONTEXT setup (\S+) (\S+) (\S+) (\S+) (true|false)$/u.exec(stderrLines[0]!);
        expect(setupMatch, `unexpected setup context line: ${stderrLines[0]}`).not.toBeNull();
        const decodeContextToken = (token: string) => {
          if (token === "-") return "";
          const value = Buffer.from(token, "base64");
          expect(value.toString("base64")).toBe(token);
          return value.toString("utf8");
        };
        const setupContext = {
          before: decodeContextToken(setupMatch![1]!),
          after: decodeContextToken(setupMatch![2]!),
          psHome: decodeContextToken(setupMatch![3]!),
          target: decodeContextToken(setupMatch![4]!),
          targetExists: setupMatch![5] === "true",
        };
        expect(setupContext.targetExists).toBe(true);
        expect(setupContext.psHome).not.toBe("");
        expect(setupContext.target).not.toBe("");
        expect(setupContext.target.toLowerCase()).toBe(join(setupContext.psHome, "Modules").toLowerCase());
        expect(result.modulePathStrategy).toBe("legacy-unset");
        expect(result.childPSModulePath).toBeNull();
        expect(setupContext.psHome.toLowerCase()).toBe(dirname(result.powerShellExecutablePath).toLowerCase());
        expect(setupContext.after).toBe(localizationCase.setsPsModulePath ? setupContext.target : setupContext.before);
        if (localizationCase.setsPsModulePath) {
          expect(setupContext.after).not.toBe(setupContext.before);
          expect(baselineSetup?.psHome.toLowerCase()).toBe(setupContext.psHome.toLowerCase());
          expect(baselineSetup?.target.toLowerCase()).toBe(setupContext.target.toLowerCase());
        } else {
          expect(setupContext.after).toBe(setupContext.before);
        }

        const observedMarkers = stderrLines.slice(1, expectedMarkerLabels.length + 1).map((line) => {
          const match = /^PR64_WRAPPER_PATH_MARKER ([a-z-]+) ([0-9]+) ([0-9]+) (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}(?:Z|\+00:00))$/u.exec(line);
          expect(match, `unexpected wrapper stderr line: ${line}`).not.toBeNull();
          return { label: match![1]!, elapsedTicks: Number(match![2]), frequency: Number(match![3]), utc: match![4]! };
        });
        expect(observedMarkers.map(({ label }) => label)).toEqual(expectedMarkerLabels);
        expect(observedMarkers.every(({ frequency }) => frequency === observedMarkers[0]?.frequency && frequency > 0)).toBe(true);
        expect(observedMarkers.every(({ elapsedTicks }, index) => Number.isSafeInteger(elapsedTicks) && (index === 0 || elapsedTicks >= observedMarkers[index - 1]!.elapsedTicks))).toBe(true);

        const moduleMatch = /^PR64_MODULE_CONTEXT module (\S+) (\S+) (\S+) (\S+) (true|false)$/u.exec(stderrLines[stderrLines.length - 1]!);
        expect(moduleMatch, `unexpected module context line: ${stderrLines[stderrLines.length - 1]}`).not.toBeNull();
        const moduleContext = {
          command: decodeContextToken(moduleMatch![1]!),
          source: decodeContextToken(moduleMatch![2]!),
          name: decodeContextToken(moduleMatch![3]!),
          path: decodeContextToken(moduleMatch![4]!),
          loaded: moduleMatch![5] === "true",
        };
        expect(moduleContext).toMatchObject({ command: "Split-Path", source: "Microsoft.PowerShell.Management", name: "Microsoft.PowerShell.Management", loaded: true });
        const moduleRootPrefix = `${setupContext.target.replace(/[\\/]+$/gu, "").replace(/\\/gu, "/").toLowerCase()}/`;
        expect(moduleContext.path.replace(/\\/gu, "/").toLowerCase().startsWith(moduleRootPrefix)).toBe(true);
        if (localizationCase.name === "baseline") {
          baselineSetup = setupContext;
          baselineModule = moduleContext;
        } else {
          expect(baselineModule?.source).toBe(moduleContext.source);
          expect(baselineModule?.name).toBe(moduleContext.name);
          expect(baselineModule?.path.toLowerCase()).toBe(moduleContext.path.toLowerCase());
        }

        const intervalMs = (from: string, to: string) => {
          const start = observedMarkers.find((item) => item.label === from)!;
          const end = observedMarkers.find((item) => item.label === to)!;
          return Math.round(((end.elapsedTicks - start.elapsedTicks) * 1_000 / start.frequency) * 1000) / 1000;
        };
        const evidence = {
          schemaVersion: 1,
          case: localizationCase.name,
          manipulatedVariable: "child-process PSModulePath only; treatment assigns PSHOME\\Modules when Directory.Exists is true",
          fixedHead: "1587f1f62c09649afd308cc65dcab97e189a645f",
          sourceNormalizedSha256,
          instrumentedSha256,
          scriptsDifferOnlyByTreatmentFlag: localizationCase.name === "baseline" || comparableScript === baselineComparableScript,
          instrumentationNeedleOccurrences: replacements.map(({ label }) => ({ label, count: 1 })),
          processModuleContext: {
            setsPsModulePath: localizationCase.setsPsModulePath,
            parentProcessPSModulePath: { status: result.parentPSModulePathStatus, sha256: result.parentPSModulePathSha256 },
            childSpawnPSModulePath: result.childPSModulePath,
            resolvedPowerShellExecutable: result.powerShellExecutablePath,
            childObservedPowerShellHome: setupContext.psHome,
            before: setupContext.before,
            after: setupContext.after,
            psHome: setupContext.psHome,
            target: setupContext.target,
            targetExists: setupContext.targetExists,
          },
          splitPathModuleAfterMeasurement: moduleContext,
          invocation: {
            diagnosticId: result.diagnosticId,
            helperCallStartedAtUtc,
            helperCallCompletedAtUtc,
            platform: process.platform,
            node: process.version,
            owningTimeoutMs: 30_000,
            helperTimeoutMs: null,
            retry: 0,
            repeats: 0,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
            stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
            expectedStdoutBytes: Buffer.byteLength(expectedBlockedOutput, "utf8"),
            stdoutEnded: result.stdoutEnded,
            stderrEnded: result.stderrEnded,
          },
          markers: observedMarkers,
          intervalsMs: {
            scriptEntryToSplitPath: intervalMs("script-entry", "split-parent-before"),
            splitPathParent: intervalMs("split-parent-before", "split-parent-after"),
            curationGuardToCatch: intervalMs("curation-before", "bootstrap-catch"),
            jsonSerialization: intervalMs("json-serialization-before", "json-serialization-after"),
          },
          timingLimits: [
            "UTC is sampled while emitting each marker and is not the child-stderr arrival time.",
            "Stopwatch deltas begin after parameter binding and the .NET-only module-path context preamble.",
            "The module-source observer runs only after all seven timed markers.",
            "Marker formatting and stderr writes contribute overhead to neighboring intervals.",
          ],
        };
        await writeFile(join(evidenceCaseRoot, "invocation-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(2);
        expect(result.stdout).toBe(expectedBlockedOutput);
        expect(Buffer.byteLength(result.stdout, "utf8")).toBe(158);
        expect(result.stdoutEnded).toBe(true);
        expect(result.stderrEnded).toBe(true);
        expect(context.signal.aborted).toBe(false);
        expect(await pathExists(invocationMarker.markerPath)).toBe(false);
        expect(await pathExists(payloadPath)).toBe(false);
        expect(await pathExists(sourceWindowPath)).toBe(false);
        expect(await pathExists(memoryDatabasePath)).toBe(false);
        expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
        expect(await pathExists(join(dirname(dirname(installedEntry)), ".runtime-root"))).toBe(false);
        callVerified = true;
      } finally {
        if (fixtureRootCreated) {
          await rm(root, { recursive: true, force: true });
          fixtureRootCreated = false;
          fixtureCleanupCompleted = true;
        }
      }
    });
  }
});
