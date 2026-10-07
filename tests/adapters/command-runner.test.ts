import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { redactSensitiveText, runCommand, terminateProcessTree, type ProcessGroupInspection } from "../../src/adapters/command-runner.js";

function processIsRunning(pid: number, observe?: (observation: { queryCode: string; linuxProcState: string }) => void): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const isZombie = /\)\s+Z\s/.test(stat);
        observe?.({ queryCode: "SUCCESS", linuxProcState: isZombie ? "Z" : "RUNNING" });
        return !isZombie;
      } catch {
        observe?.({ queryCode: "SUCCESS", linuxProcState: "UNKNOWN" });
        return true;
      }
    }
    observe?.({ queryCode: "SUCCESS", linuxProcState: "NOT_APPLICABLE" });
    return true;
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "UNKNOWN";
    observe?.({ queryCode: code, linuxProcState: "NOT_APPLICABLE" });
    return false;
  }
}

function captureDiagnosticStream(value: string | undefined): {
  state: "CAPTURED" | "CAPTURED_EMPTY" | "NOT_CAPTURED";
  text: string | null;
  originalUtf8Bytes: number | null;
  redactedUtf8Bytes: number | null;
  truncated: boolean;
} {
  if (value === undefined) {
    return { state: "NOT_CAPTURED", text: null, originalUtf8Bytes: null, redactedUtf8Bytes: null, truncated: false };
  }
  const redacted = redactSensitiveText(value);
  const originalUtf8Bytes = Buffer.byteLength(value, "utf8");
  const redactedUtf8Bytes = Buffer.byteLength(redacted, "utf8");
  let text = "";
  let capturedUtf8Bytes = 0;
  for (const character of redacted) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (capturedUtf8Bytes + characterBytes > 256) break;
    text += character;
    capturedUtf8Bytes += characterBytes;
  }
  return {
    state: value.length === 0 ? "CAPTURED_EMPTY" : "CAPTURED",
    text,
    originalUtf8Bytes,
    redactedUtf8Bytes,
    truncated: capturedUtf8Bytes < redactedUtf8Bytes,
  };
}

function terminateFixtureProcess(child: ChildProcess): boolean {
  const killResult = child.kill("SIGKILL");
  return killResult || child.pid === undefined || !processIsRunning(child.pid);
}

describe("redactSensitiveText", () => {
  it.each([
    ["password=\"quoted-secret\"", "password=[REDACTED]"],
    ["password=plain-secret", "password=[REDACTED]"],
    ["token='quoted-secret'", "token=[REDACTED]"],
    ["credential=\"quoted-secret\"", "credential=[REDACTED]"],
    ["access-token=\"quoted-secret\"", "access-token=[REDACTED]"],
    ["private_key='quoted-secret'", "private_key=[REDACTED]"],
    ["cookie=\"quoted-secret\"", "cookie=[REDACTED]"],
    ["session-token='quoted-secret'", "session-token=[REDACTED]"],
    ["auth=plain-secret", "auth=[REDACTED]"],
    ['Authorization: Bearer "quoted-token"', "Authorization: Bearer [REDACTED]"],
    ["Authorization: Bearer plain-token", "Authorization: Bearer [REDACTED]"],
    ["authorization: bearer 'quoted-token'", "authorization: bearer [REDACTED]"],
  ])("redacts quoted credentials: %s", (value, expected) => {
    expect(redactSensitiveText(value)).toBe(expected);
  });

  it("redacts values that follow separate sensitive arguments", async () => {
    const result = await runCommand({
      command: process.execPath,
      arguments: ["-e", "process.exit(0)", "--", "--password", "hunter2", "--token", "token-value"],
      cwd: null,
    });

    expect(result.arguments).toEqual(["-e", "process.exit(0)", "--", "--password", "[REDACTED]", "--token", "[REDACTED]"]);
  });

  it("redacts credentials embedded in URL userinfo from arguments and output", async () => {
    const credentialUrl = "https://user:fixture-secret@example.com/repo";
    const result = await runCommand({
      command: process.execPath,
      arguments: ["-e", `process.stdout.write(${JSON.stringify(credentialUrl)})`, "--", credentialUrl],
      cwd: null,
    });

    expect(result.arguments.at(-1)).toBe("https://[REDACTED]@example.com/repo");
    expect(result.stdout).toBe("https://[REDACTED]@example.com/repo");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });

  it("retains no more than the configured byte bound when one output chunk is oversized", async () => {
    const maxOutputBytes = 32;
    let thrown: unknown;
    try {
      await runCommand({
        command: process.execPath,
        arguments: ["-e", `process.stdout.write("x".repeat(${maxOutputBytes * 100}))`],
        cwd: null,
        maxOutputBytes,
      });
      throw new Error("Expected oversized output to be rejected");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ result: expect.objectContaining({ exitCode: null }) });
    const result = (thrown as { result?: { stdout: string; stderr: string } }).result;
    expect(result).toBeDefined();
    expect(Buffer.byteLength(result?.stdout ?? "") + Buffer.byteLength(result?.stderr ?? "")).toBeLessThanOrEqual(maxOutputBytes);
  });

  it("keeps a multibyte output chunk within the configured byte bound", async () => {
    const maxOutputBytes = 1;
    let thrown: unknown;
    try {
      await runCommand({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('😀')"],
        cwd: null,
        maxOutputBytes,
      });
      throw new Error("Expected multibyte output to be rejected");
    } catch (error: unknown) {
      thrown = error;
    }
    const result = (thrown as { result?: { stdout: string; stderr: string } }).result;
    expect(Buffer.byteLength(result?.stdout ?? "") + Buffer.byteLength(result?.stderr ?? "")).toBeLessThanOrEqual(maxOutputBytes);
  });

  it.each(["timeout", "output-limit"] as const)("retains bounded diagnostics from stdout and stderr on %s", async (failureMode) => {
    const maxOutputBytes = 128;
    const script = failureMode === "timeout"
      ? "process.stdout.write('stdout-diagnostic'); process.stderr.write('stderr-diagnostic'); setInterval(() => {}, 1000)"
      : "process.stdout.write('stdout-diagnostic'); process.stderr.write('stderr-diagnostic'); setTimeout(() => process.stdout.write('x'.repeat(1000)), 100)";
    const runFailure = async (): Promise<{ stdout: string; stderr: string }> => {
      try {
        await runCommand({
          command: process.execPath,
          arguments: ["-e", script],
          cwd: null,
          timeoutMs: 1_000,
          maxOutputBytes,
          terminateProcessTree: async (child) => terminateFixtureProcess(child),
        });
      } catch (error: unknown) {
        return (error as { result: { stdout: string; stderr: string } }).result;
      }
      throw new Error("Expected the diagnostic command to fail");
    };
    const result = await runFailure();
    const repeated = await runFailure();
    expect(result).toBeDefined();
    expect(result?.stdout).toContain("stdout-diagnostic");
    expect(result?.stderr).toContain("stderr-diagnostic");
    expect(result?.stderr).toContain(failureMode === "timeout" ? "Command timed out" : "Command output exceeded the configured limit");
    expect(repeated).toEqual(result);
    expect(Buffer.byteLength(result?.stdout ?? "") + Buffer.byteLength(result?.stderr ?? "")).toBeLessThanOrEqual(maxOutputBytes);
  }, 15_000);

  it("treats an already-exited output-limit fixture child as successfully cleaned up", async () => {
    let thrown: unknown;
    try {
      await runCommand({
        command: process.execPath,
        arguments: ["-e", "process.stdout.write('stdout-diagnostic'); process.stderr.write('stderr-diagnostic'); process.stdout.write('x'.repeat(1000))"],
        cwd: null,
        maxOutputBytes: 128,
        terminateProcessTree: async (child) => {
          if (child.exitCode === null && child.signalCode === null) {
            await new Promise<void>((resolve) => child.once("close", () => resolve()));
          }
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
          if (child.pid !== undefined) expect(processIsRunning(child.pid)).toBe(false);
          return terminateFixtureProcess(child);
        },
      });
      throw new Error("Expected the diagnostic command to fail");
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ result: expect.objectContaining({ exitCode: null }) });
    expect((thrown as { result: { stderr: string } }).result.stderr).not.toContain("Process tree cleanup");
  });

  it("terminates a descendant process when a command times out", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-command-timeout-"));
    const pidPath = join(root, "descendant.pid");
    const startedAt = performance.now();
    const diagnostic = {
      rootPid: null as number | null,
      terminator: {
        entryMs: null as number | null,
        completionMs: null as number | null,
        outcome: "NOT_CALLED" as "NOT_CALLED" | "TRUE" | "FALSE" | "THREW",
        thrownName: null as string | null,
        exitEvent: "NOT OBSERVED" as "NOT OBSERVED" | { code: number | null; signal: NodeJS.Signals | null },
        closeEvent: "NOT OBSERVED" as "NOT OBSERVED" | { code: number | null; signal: NodeJS.Signals | null },
      },
      commandResult: {
        state: "NOT_OBSERVED" as "NOT_OBSERVED" | "OBSERVED",
        errorName: null as string | null,
        exitCodeState: "NOT_OBSERVED" as "NOT_OBSERVED" | "OBSERVED",
        exitCode: null as number | null,
        timeoutMarker: null as boolean | null,
        cleanupFailureMarker: null as boolean | null,
      },
      stdout: captureDiagnosticStream(undefined),
      stderr: captureDiagnosticStream(undefined),
      descendant: {
        pid: null as number | null,
        pidFileRead: "NOT_OBSERVED" as "NOT_OBSERVED" | "CAPTURED",
        pidFileValue: null as string | null,
        running: null as boolean | null,
        queryCode: "NOT_OBSERVED",
        linuxProcState: "NOT_OBSERVED",
        verifiedGone: false,
      },
    };
    const fallback = {
      pidFile: "NOT_READ" as "NOT_READ" | "READ" | "READ_ERROR",
      descendantPid: null as number | null,
      attempt: "NOT_STARTED" as "NOT_STARTED" | "NOT_NEEDED" | "KILL_REQUESTED" | "QUERY_UNKNOWN" | "ERROR",
      queryCode: "NOT_OBSERVED",
      errorName: null as string | null,
      outputErrorName: null as string | null,
      rootAttempt: "NOT_NEEDED" as "NOT_NEEDED" | "NOT_ATTEMPTED_UNKNOWN" | "TRUE" | "FALSE" | "ERROR",
      rootCleanupErrorName: null as string | null,
      rootCleanupResult: null as boolean | null,
      residual: {
        root: { state: "NOT_OBSERVED" as string, queryCode: "NOT_OBSERVED", linuxProcState: "NOT_OBSERVED" },
        descendant: { state: "NOT_OBSERVED" as string, queryCode: "NOT_OBSERVED", linuxProcState: "NOT_OBSERVED" },
      },
    };
    let hasOriginalFailure = false;
    let originalFailure: unknown;
    let fixtureRoot: ChildProcess | undefined;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(descendant.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    try {
      const commandPromise = runCommand({
        command: process.execPath,
        arguments: ["-e", script, pidPath],
        cwd: null,
        timeoutMs: 1_000,
        terminateProcessTree: async (child, options) => {
          fixtureRoot = child;
          diagnostic.rootPid = child.pid ?? null;
          diagnostic.terminator.entryMs = Number((performance.now() - startedAt).toFixed(3));
          child.once("exit", (code, signal) => {
            diagnostic.terminator.exitEvent = { code, signal };
          });
          child.once("close", (code, signal) => {
            diagnostic.terminator.closeEvent = { code, signal };
          });
          try {
            const result = await terminateProcessTree(child, options);
            diagnostic.terminator.completionMs = Number((performance.now() - startedAt).toFixed(3));
            diagnostic.terminator.outcome = result ? "TRUE" : "FALSE";
            return result;
          } catch (error: unknown) {
            diagnostic.terminator.completionMs = Number((performance.now() - startedAt).toFixed(3));
            diagnostic.terminator.outcome = "THREW";
            diagnostic.terminator.thrownName = error instanceof Error ? error.name : typeof error;
            throw error;
          }
        },
      }).then(
        (result) => {
          diagnostic.commandResult.state = "OBSERVED";
          diagnostic.commandResult.exitCodeState = "OBSERVED";
          diagnostic.commandResult.exitCode = result.exitCode;
          diagnostic.commandResult.timeoutMarker = result.stderr.includes("Command timed out");
          diagnostic.commandResult.cleanupFailureMarker = result.stderr.includes("Process tree cleanup could not be established");
          diagnostic.stdout = captureDiagnosticStream(result.stdout);
          diagnostic.stderr = captureDiagnosticStream(result.stderr);
          return result;
        },
        (error: unknown) => {
          const errorResult = typeof error === "object" && error !== null && "result" in error
            ? error.result
            : undefined;
          const commandResult = typeof errorResult === "object" && errorResult !== null
            ? errorResult as { stdout?: string; stderr?: string; exitCode?: number | null }
            : undefined;
          diagnostic.commandResult.state = commandResult === undefined ? "NOT_OBSERVED" : "OBSERVED";
          diagnostic.commandResult.errorName = typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
            ? error.name
            : null;
          diagnostic.commandResult.exitCodeState = commandResult !== undefined && "exitCode" in commandResult
            ? "OBSERVED"
            : "NOT_OBSERVED";
          diagnostic.commandResult.exitCode = diagnostic.commandResult.exitCodeState === "OBSERVED"
            ? commandResult?.exitCode ?? null
            : null;
          diagnostic.commandResult.timeoutMarker = commandResult === undefined || commandResult.stderr === undefined
            ? null
            : commandResult.stderr.includes("Command timed out");
          diagnostic.commandResult.cleanupFailureMarker = commandResult === undefined || commandResult.stderr === undefined
            ? null
            : commandResult.stderr.includes("Process tree cleanup could not be established");
          diagnostic.stdout = captureDiagnosticStream(commandResult?.stdout);
          diagnostic.stderr = captureDiagnosticStream(commandResult?.stderr);
          throw error;
        },
      );
      await expect(commandPromise).rejects.toMatchObject({ result: expect.objectContaining({ exitCode: null }) });
      let descendantPid = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          const pidContents = await readFile(pidPath, "utf8");
          diagnostic.descendant.pidFileRead = "CAPTURED";
          diagnostic.descendant.pidFileValue = pidContents;
          descendantPid = Number(pidContents);
          diagnostic.descendant.pid = descendantPid;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(Number.isInteger(descendantPid)).toBe(true);
      expect(descendantPid).toBeGreaterThan(0);
      const descendantRunning = processIsRunning(descendantPid, (observation) => {
        diagnostic.descendant.queryCode = observation.queryCode;
        diagnostic.descendant.linuxProcState = observation.linuxProcState;
      });
      diagnostic.descendant.running = descendantRunning;
      diagnostic.descendant.verifiedGone = diagnostic.descendant.queryCode === "ESRCH"
        || (process.platform === "linux" && diagnostic.descendant.queryCode === "SUCCESS" && diagnostic.descendant.linuxProcState === "Z");
      expect(descendantRunning).toBe(false);
      expect(diagnostic.descendant.verifiedGone).toBe(true);
      expect(diagnostic.terminator.outcome).toBe("TRUE");
    } catch (error: unknown) {
      hasOriginalFailure = true;
      originalFailure = error;
    } finally {
      try {
        console.info(`[PR66-COMMAND-CLEANUP-001] ${JSON.stringify(diagnostic)}`);
      } catch (error: unknown) {
        fallback.outputErrorName = error instanceof Error ? error.name : typeof error;
        if (!hasOriginalFailure) {
          hasOriginalFailure = true;
          originalFailure = error;
        }
      }
      let pidContents: string | undefined;
      try {
        pidContents = await readFile(pidPath, "utf8");
        fallback.pidFile = "READ";
      } catch (error: unknown) {
        fallback.pidFile = "READ_ERROR";
        fallback.attempt = "ERROR";
        fallback.errorName = error instanceof Error ? error.name : typeof error;
      }
      if (pidContents !== undefined) {
        try {
          const descendantPid = Number(pidContents);
          fallback.descendantPid = Number.isInteger(descendantPid) && descendantPid > 0 ? descendantPid : null;
          if (fallback.descendantPid !== null) {
            const fallbackRunning = processIsRunning(descendantPid, (observation) => {
              fallback.queryCode = observation.queryCode;
            });
            if (fallbackRunning) {
              process.kill(descendantPid);
              fallback.attempt = "KILL_REQUESTED";
            } else if (fallback.queryCode === "ESRCH" || (process.platform === "linux" && fallback.queryCode === "SUCCESS")) {
              fallback.attempt = "NOT_NEEDED";
            } else {
              fallback.attempt = "QUERY_UNKNOWN";
            }
          } else {
            fallback.attempt = "QUERY_UNKNOWN";
          }
        } catch (error: unknown) {
          fallback.attempt = "ERROR";
          fallback.errorName = error instanceof Error ? error.name : typeof error;
        }
      }
      const observeResidual = (pid: number | null): { state: string; queryCode: string; linuxProcState: string } => {
        if (pid === null || !Number.isInteger(pid) || pid <= 0) {
          return { state: "NOT_OBSERVED", queryCode: "NOT_OBSERVED", linuxProcState: "NOT_OBSERVED" };
        }
        let queryCode = "NOT_OBSERVED";
        let linuxProcState = "NOT_OBSERVED";
        const running = processIsRunning(pid, (observation) => {
          queryCode = observation.queryCode;
          linuxProcState = observation.linuxProcState;
        });
        const verifiedGone = queryCode === "ESRCH"
          || (process.platform === "linux" && queryCode === "SUCCESS" && linuxProcState === "Z");
        return {
          state: verifiedGone ? "VERIFIED_GONE" : running ? "RUNNING" : "UNKNOWN",
          queryCode,
          linuxProcState,
        };
      };
      fallback.residual.root = observeResidual(diagnostic.rootPid);
      fallback.residual.descendant = observeResidual(fallback.descendantPid ?? diagnostic.descendant.pid);
      if (fallback.residual.root.state === "RUNNING") {
        if (fixtureRoot?.pid !== undefined && fixtureRoot.exitCode === null && fixtureRoot.signalCode === null) {
          try {
            fallback.rootCleanupResult = terminateFixtureProcess(fixtureRoot);
            fallback.rootAttempt = fallback.rootCleanupResult ? "TRUE" : "FALSE";
          } catch (error: unknown) {
            fallback.rootAttempt = "ERROR";
            fallback.rootCleanupErrorName = error instanceof Error ? error.name : typeof error;
          }
          fallback.residual.root = observeResidual(diagnostic.rootPid);
        } else {
          fallback.rootAttempt = "NOT_ATTEMPTED_UNKNOWN";
        }
      } else if (fallback.residual.root.state === "UNKNOWN") {
        fallback.rootAttempt = "NOT_ATTEMPTED_UNKNOWN";
      }
      try {
        console.info(`[PR66-COMMAND-CLEANUP-001-POST] ${JSON.stringify(fallback)}`);
      } catch (error: unknown) {
        if (!hasOriginalFailure) {
          hasOriginalFailure = true;
          originalFailure = error;
        }
      }
      if (!hasOriginalFailure && (fallback.residual.root.state !== "VERIFIED_GONE" || fallback.residual.descendant.state !== "VERIFIED_GONE")) {
        hasOriginalFailure = true;
        originalFailure = new Error("Fixture root or descendant residual state could not be verified gone");
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error: unknown) {
        if (!hasOriginalFailure) {
          hasOriginalFailure = true;
          originalFailure = error;
        }
      }
    }
    if (hasOriginalFailure) throw originalFailure;
  }, 15_000);

  it("fails closed when injected process-tree cleanup cannot establish descendant termination", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-command-cleanup-failure-"));
    const pidPath = join(root, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], String(descendant.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    try {
      await expect(runCommand({
        command: process.execPath,
        arguments: ["-e", script, pidPath],
        cwd: null,
        timeoutMs: 1_000,
        terminateProcessTree: async (child) => {
          if (process.platform === "win32" || child.pid === undefined) child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
          return false;
        },
      })).rejects.toMatchObject({ result: expect.objectContaining({ stderr: expect.stringMatching(/cleanup|descendant|termination/i) }) });
      let descendantPid = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          descendantPid = Number(await readFile(pidPath, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(descendantPid).toBeGreaterThan(0);
    } finally {
      try {
        const descendantPid = Number(await readFile(pidPath, "utf8"));
        if (Number.isInteger(descendantPid) && processIsRunning(descendantPid)) process.kill(descendantPid);
      } catch {
        // The command may have terminated before writing its child pid.
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("waits for active Linux process-group members before returning success", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let now = 0;
    const sleepCalls: number[] = [];
    const inspections: ProcessGroupInspection[] = [
      { status: "ok", members: [{ state: "S" }] },
      { status: "ok", members: [{ state: "R" }] },
      { status: "ok", members: [] },
    ];
    try {
      const result = await terminateProcessTree({ pid: 4321 } as ChildProcess, {
        timeoutMs: 50,
        now: () => now,
        sleep: async (milliseconds) => {
          sleepCalls.push(milliseconds);
          now += milliseconds;
        },
        inspectProcessGroup: () => inspections.shift() ?? { status: "ok", members: [] },
      });
      expect(result).toBe(true);
      expect(sleepCalls).toEqual([10, 10]);
      expect(kill).toHaveBeenCalledWith(-4321, "SIGKILL");
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")("returns false at the bounded Linux cleanup deadline", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let now = 0;
    const sleepCalls: number[] = [];
    try {
      const result = await terminateProcessTree({ pid: 4322 } as ChildProcess, {
        timeoutMs: 25,
        now: () => now,
        sleep: async (milliseconds) => {
          sleepCalls.push(milliseconds);
          now += milliseconds;
        },
        inspectProcessGroup: () => ({ status: "ok", members: [{ state: "S" }] }),
      });
      expect(result).toBe(false);
      expect(sleepCalls).toEqual([10, 10, 5]);
      expect(sleepCalls.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(25);
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")("treats Linux zombie-only process-group membership as cleaned up", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const sleep = vi.fn(async () => undefined);
    try {
      const result = await terminateProcessTree({ pid: 4323 } as ChildProcess, {
        inspectProcessGroup: () => ({ status: "ok", members: [{ state: "Z" }] }),
        sleep,
      });
      expect(result).toBe(true);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")("fails closed when Linux process-group inspection errors", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const sleep = vi.fn(async () => undefined);
    try {
      const result = await terminateProcessTree({ pid: 4324 } as ChildProcess, {
        inspectProcessGroup: () => ({ status: "error" }),
        sleep,
      });
      expect(result).toBe(false);
      expect(sleep).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform !== "linux")("fails closed at the Linux cleanup deadline when sleep never resolves", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      const cleanup = terminateProcessTree({ pid: 4325 } as ChildProcess, {
        timeoutMs: 25,
        inspectProcessGroup: () => ({ status: "ok", members: [{ state: "S" }] }),
        sleep: async (_milliseconds, operationSignal) => {
          signal = operationSignal;
          return await new Promise<void>(() => undefined);
        },
      });
      for (let turn = 0; turn < 10 && signal === undefined; turn += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await expect(cleanup).resolves.toBe(false);
      expect(signal?.aborted).toBe(true);
    } finally {
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "linux")("consumes a late Linux cleanup sleep rejection after the deadline", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    vi.useFakeTimers();
    let rejectLate: ((reason?: unknown) => void) | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.once("unhandledRejection", onUnhandled);
    try {
      const cleanup = terminateProcessTree({ pid: 4326 } as ChildProcess, {
        timeoutMs: 25,
        inspectProcessGroup: () => ({ status: "ok", members: [{ state: "S" }] }),
        sleep: async () => await new Promise<void>((_resolve, reject) => {
          rejectLate = reject;
        }),
      });
      for (let turn = 0; turn < 10 && rejectLate === undefined; turn += 1) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);
      await expect(cleanup).resolves.toBe(false);
      expect(rejectLate).toBeDefined();
      if (rejectLate === undefined) throw new Error("Expected to capture the late Linux cleanup rejection");
      rejectLate(new Error("late Linux cleanup sleep failure"));
      await vi.runOnlyPendingTimersAsync();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "linux")("rejects an empty Linux inspection that arrives at the deadline", async () => {
    let now = 0;
    let inspectionCalls = 0;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    try {
      const result = await terminateProcessTree({ pid: 4327 } as ChildProcess, {
        timeoutMs: 10,
        now: () => now,
        inspectProcessGroup: () => {
          inspectionCalls += 1;
          if (inspectionCalls === 1) return { status: "ok", members: [{ state: "S" }] };
          now = 10;
          return { status: "ok", members: [] };
        },
        sleep: async () => {
          now = 1;
        },
      });
      expect(result).toBe(false);
      expect(inspectionCalls).toBe(2);
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("verifies an already-gone process group after ESRCH", async () => {
    const error = Object.assign(new Error("process group already gone"), { code: "ESRCH" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const inspectProcessGroup = vi.fn((processGroupId: number): ProcessGroupInspection => {
      expect(processGroupId).toBe(4328);
      return { status: "ok", members: [] };
    });
    try {
      const result = await terminateProcessTree({ pid: 4328 } as ChildProcess, {
        inspectProcessGroup,
      });
      expect(result).toBe(true);
      expect(inspectProcessGroup).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")("fails closed for non-ESRCH process-group signal errors", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const inspectProcessGroup = vi.fn((): ProcessGroupInspection => ({ status: "ok", members: [] }));
    try {
      const result = await terminateProcessTree({ pid: 4329 } as ChildProcess, {
        inspectProcessGroup,
      });
      expect(result).toBe(false);
      expect(inspectProcessGroup).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it.skipIf(process.platform !== "win32")("uses one global deadline for large Windows descendant cleanup trees", async () => {
    let now = 0;
    const taskkillPids: number[] = [];
    const remainingBudgets: number[] = [];
    const descendants = Array.from({ length: 1_000 }, (_, index) => index + 2);
    const result = await terminateProcessTree({ pid: 1 } as ChildProcess, {
      timeoutMs: 100,
      now: () => now,
      queryProcessTree: async (_rootPid, remainingMs) => {
        remainingBudgets.push(remainingMs);
        return descendants;
      },
      runTaskkill: async (pid, remainingMs) => {
        taskkillPids.push(pid);
        remainingBudgets.push(remainingMs);
        now += 60;
        return pid === 1;
      },
      sleep: async () => undefined,
      processIsAlive: () => true,
    });

    expect(result).toBe(false);
    expect(taskkillPids).toEqual([1, 1_001]);
    expect(taskkillPids).not.toContain(2);
    expect(remainingBudgets.every((budget) => budget >= 0 && budget <= 100)).toBe(true);
    expect(remainingBudgets.at(-1)).toBe(40);
  });

  it.skipIf(process.platform !== "win32")("fails closed when process-tree discovery never resolves", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      let now = 0;
      const cleanup = terminateProcessTree({ pid: 1 } as ChildProcess, {
        timeoutMs: 25,
        now: () => now,
        queryProcessTree: async (_rootPid, _remainingMs, operationSignal) => {
          signal = operationSignal;
          return await new Promise<readonly number[] | null>(() => undefined);
        },
        processIsAlive: () => true,
      });
      for (let turn = 0; turn < 10 && signal === undefined; turn += 1) await Promise.resolve();
      now = 25;
      await vi.advanceTimersByTimeAsync(25);
      await expect(cleanup).resolves.toBe(false);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "win32")("fails closed when taskkill never resolves and consumes no extra deadline", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    try {
      let now = 0;
      const cleanup = terminateProcessTree({ pid: 1 } as ChildProcess, {
        timeoutMs: 25,
        now: () => now,
        queryProcessTree: async () => [2],
        runTaskkill: async (_pid, _remainingMs, operationSignal) => {
          signal = operationSignal;
          return await new Promise<boolean>(() => undefined);
        },
        processIsAlive: () => true,
      });
      for (let turn = 0; turn < 10 && signal === undefined; turn += 1) await Promise.resolve();
      now = 25;
      await vi.advanceTimersByTimeAsync(25);
      await expect(cleanup).resolves.toBe(false);
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "win32")("consumes a late cleanup rejection after the global deadline", async () => {
    vi.useFakeTimers();
    let rejectLate: ((reason?: unknown) => void) | undefined;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.once("unhandledRejection", onUnhandled);
    try {
      let now = 0;
      const cleanup = terminateProcessTree({ pid: 1 } as ChildProcess, {
        timeoutMs: 25,
        now: () => now,
        queryProcessTree: async () => [2],
        runTaskkill: async () => await new Promise<boolean>((_resolve, reject) => {
          rejectLate = reject;
        }),
        processIsAlive: () => true,
      });
      for (let turn = 0; turn < 10 && rejectLate === undefined; turn += 1) await Promise.resolve();
      now = 25;
      await vi.advanceTimersByTimeAsync(25);
      await expect(cleanup).resolves.toBe(false);
      expect(rejectLate).toBeDefined();
      rejectLate?.(new Error("late taskkill failure"));
      await vi.runOnlyPendingTimersAsync();
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "win32")("fails closed when an empty-tree query succeeds after the global deadline", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let queryCalls = 0;
      const cleanup = terminateProcessTree({ pid: 1 } as ChildProcess, {
        timeoutMs: 100,
        now: () => now,
        queryProcessTree: async () => {
          queryCalls += 1;
          if (queryCalls === 1) return [2];
          now = 100;
          return [];
        },
        runTaskkill: async () => true,
        processIsAlive: () => false,
      });

      await expect(cleanup).resolves.toBe(false);
      expect(queryCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "win32")("fails closed when taskkill succeeds after the global deadline", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const cleanup = terminateProcessTree({ pid: 1 } as ChildProcess, {
        timeoutMs: 100,
        now: () => now,
        queryProcessTree: async () => [2],
        runTaskkill: async () => {
          now = 100;
          return true;
        },
        processIsAlive: () => false,
      });

      await expect(cleanup).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.skipIf(process.platform !== "win32")("accepts a successful cleanup strictly before the global deadline", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      let queryCalls = 0;
      const cleanup = terminateProcessTree({ pid: 1 } as ChildProcess, {
        timeoutMs: 100,
        now: () => now,
        queryProcessTree: async () => {
          queryCalls += 1;
          if (queryCalls === 1) return [2];
          now = 99;
          return [];
        },
        runTaskkill: async () => true,
        processIsAlive: () => false,
      });

      await expect(cleanup).resolves.toBe(true);
      expect(queryCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
