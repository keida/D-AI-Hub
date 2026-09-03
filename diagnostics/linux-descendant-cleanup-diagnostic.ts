import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandExecutionError, runCommand } from "../src/adapters/command-runner.js";

const sampleDelays = [5, 10, 25, 50, 100, 250, 500, 1_000] as const;
const outputDirectory = process.env.DIAGNOSTIC_OUTPUT_DIR ?? join(process.cwd(), "diagnostic-artifacts");

interface ProcessSnapshot {
  readonly state: string;
  readonly ppid: number | null;
  readonly pgid: number | null;
  readonly active: boolean;
}

interface GroupSnapshot {
  readonly active: boolean;
  readonly inspectionError: boolean;
}

interface DualProcessSnapshot {
  readonly root: ProcessSnapshot;
  readonly descendant: ProcessSnapshot;
  readonly rootGroup: GroupSnapshot;
}

interface DiagnosticRecord {
  readonly iteration: number;
  readonly rootPid: number;
  readonly descendantPid: number;
  readonly beforeKill: DualProcessSnapshot;
  readonly atRunCommandReturn: DualProcessSnapshot;
  readonly samples: Readonly<Record<`${number}ms`, DualProcessSnapshot>>;
  readonly cleanupFailureMarker: boolean;
  readonly cleanupEstablished: boolean;
  readonly cleanupFailure: boolean;
  readonly finalActiveSurvivors: {
    readonly root: boolean;
    readonly descendant: boolean;
    readonly rootGroup: boolean;
  };
}

interface ProcessIds {
  readonly rootPid: number;
  readonly descendantPid: number;
}

function readProcessSnapshot(pid: number): ProcessSnapshot {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return { state: "error", ppid: null, pgid: null, active: true };
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    const state = fields[0] ?? "error";
    const ppid = Number(fields[1]);
    const pgid = Number(fields[2]);
    if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return { state: "error", ppid: null, pgid: null, active: true };
    return { state, ppid, pgid, active: state !== "Z" };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", ppid: null, pgid: null, active: false };
    return { state: "error", ppid: null, pgid: null, active: true };
  }
}

function readProcessGroupSnapshot(processGroupId: number): GroupSnapshot {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return { active: true, inspectionError: true };
  }
  let inspectionError = false;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const snapshot = readProcessSnapshot(Number(entry));
    if (snapshot.state === "error") {
      inspectionError = true;
      continue;
    }
    if (snapshot.pgid === processGroupId && snapshot.active) return { active: true, inspectionError };
  }
  return { active: false, inspectionError };
}

function readDualProcessSnapshot(rootPid: number, descendantPid: number, processGroupId: number): DualProcessSnapshot {
  return {
    root: readProcessSnapshot(rootPid),
    descendant: readProcessSnapshot(descendantPid),
    rootGroup: readProcessGroupSnapshot(processGroupId),
  };
}

async function waitForProcessIds(path: string): Promise<ProcessIds> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProcessIds>;
      if (Number.isInteger(parsed.rootPid) && parsed.rootPid > 0 && Number.isInteger(parsed.descendantPid) && parsed.descendantPid > 0) {
        return { rootPid: parsed.rootPid, descendantPid: parsed.descendantPid };
      }
    } catch {
      // The fixture may not have written its metadata yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for process metadata: ${path}`);
}

function summarizeSnapshot(records: readonly DiagnosticRecord[], stage: "beforeKill" | "atRunCommandReturn" | `${number}ms`): unknown {
  const snapshots = records.map((record) => stage === "beforeKill" || stage === "atRunCommandReturn" ? record[stage] : record.samples[stage]);
  const summarizeProcess = (side: "root" | "descendant") => ({
    state: Object.fromEntries([...new Set(snapshots.map((snapshot) => snapshot[side].state))].map((state) => [state, snapshots.filter((snapshot) => snapshot[side].state === state).length])),
    ppid: Object.fromEntries([...new Set(snapshots.map((snapshot) => String(snapshot[side].ppid)))].map((ppid) => [ppid, snapshots.filter((snapshot) => String(snapshot[side].ppid) === ppid).length])),
    pgid: Object.fromEntries([...new Set(snapshots.map((snapshot) => String(snapshot[side].pgid)))].map((pgid) => [pgid, snapshots.filter((snapshot) => String(snapshot[side].pgid) === pgid).length])),
    activeCount: snapshots.filter((snapshot) => snapshot[side].active).length,
  });
  return { root: summarizeProcess("root"), descendant: summarizeProcess("descendant"), rootGroupActiveCount: snapshots.filter((snapshot) => snapshot.rootGroup.active).length };
}

describe("Linux descendant cleanup diagnostic", () => {
  it("captures dual-PID state at every required sample point", async () => {
    if (process.platform !== "linux") throw new Error("This diagnostic must run on Linux");
    rmSync(outputDirectory, { recursive: true, force: true });
    mkdirSync(outputDirectory, { recursive: true });
    const jsonlPath = join(outputDirectory, "diagnostic.jsonl");
    const fixtureScript = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "writeFileSync(process.argv[1], JSON.stringify({ rootPid: process.pid, descendantPid: descendant.pid }));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const records: DiagnosticRecord[] = [];
    try {
      for (let iteration = 1; iteration <= 30; iteration += 1) {
        const fixtureDirectory = await mkdtemp(join(tmpdir(), "d-ai-linux-cleanup-diagnostic-"));
        const metadataPath = join(fixtureDirectory, "pids.json");
        try {
          const cleanup = runCommand({
            command: process.execPath,
            arguments: ["-e", fixtureScript, metadataPath],
            cwd: null,
            timeoutMs: 1_000,
          });
          const ids = await waitForProcessIds(metadataPath);
          const beforeKillRoot = readProcessSnapshot(ids.rootPid);
          const processGroupId = beforeKillRoot.pgid ?? ids.rootPid;
          const beforeKill = readDualProcessSnapshot(ids.rootPid, ids.descendantPid, processGroupId);
          let cleanupFailureMarker = false;
          try {
            await cleanup;
            throw new Error(`Diagnostic iteration ${iteration} unexpectedly completed without timeout`);
          } catch (error: unknown) {
            if (!(error instanceof CommandExecutionError)) throw error;
            cleanupFailureMarker = error.result.stderr.includes("Process tree cleanup");
          }
          const atRunCommandReturn = readDualProcessSnapshot(ids.rootPid, ids.descendantPid, processGroupId);
          const samples: Partial<Record<`${number}ms`, DualProcessSnapshot>> = {};
          let previousDelay = 0;
          for (const delay of sampleDelays) {
            await new Promise<void>((resolve) => setTimeout(resolve, delay - previousDelay));
            samples[`${delay}ms`] = readDualProcessSnapshot(ids.rootPid, ids.descendantPid, processGroupId);
            previousDelay = delay;
          }
          const final = samples["1000ms"];
          if (final === undefined) throw new Error(`Missing final sample for iteration ${iteration}`);
          const finalActiveSurvivors = {
            root: final.root.active,
            descendant: final.descendant.active,
            rootGroup: final.rootGroup.active,
          };
          const cleanupFailure = cleanupFailureMarker && finalActiveSurvivors.rootGroup;
          const record: DiagnosticRecord = {
            iteration,
            rootPid: ids.rootPid,
            descendantPid: ids.descendantPid,
            beforeKill,
            atRunCommandReturn,
            samples: samples as Readonly<Record<`${number}ms`, DualProcessSnapshot>>,
            cleanupFailureMarker,
            cleanupEstablished: !cleanupFailureMarker,
            cleanupFailure,
            finalActiveSurvivors,
          };
          records.push(record);
          appendFileSync(jsonlPath, `${JSON.stringify(record)}\n`);
          if (finalActiveSurvivors.rootGroup) {
            try {
              process.kill(-ids.rootPid, "SIGKILL");
            } catch {
              // The safety cleanup is best effort after recording a true survivor.
            }
          }
          expect(record.cleanupFailureMarker).toBe(false);
          expect(record.cleanupFailure).toBe(false);
          expect(record.finalActiveSurvivors.root).toBe(false);
          expect(record.finalActiveSurvivors.descendant).toBe(false);
          expect(record.finalActiveSurvivors.rootGroup).toBe(false);
        } finally {
          await rm(fixtureDirectory, { recursive: true, force: true });
        }
      }
    } finally {
      const summary = {
        iterations: records.length,
        cleanupEstablishedCount: records.filter((record) => record.cleanupEstablished).length,
        cleanupFailureMarkerCount: records.filter((record) => record.cleanupFailureMarker).length,
        cleanupFailureCount: records.filter((record) => record.cleanupFailure).length,
        finalActiveSurvivorCounts: {
          root: records.filter((record) => record.finalActiveSurvivors.root).length,
          descendant: records.filter((record) => record.finalActiveSurvivors.descendant).length,
          rootGroup: records.filter((record) => record.finalActiveSurvivors.rootGroup).length,
        },
        distributions: {
          beforeKill: summarizeSnapshot(records, "beforeKill"),
          atRunCommandReturn: summarizeSnapshot(records, "atRunCommandReturn"),
          samples: Object.fromEntries(sampleDelays.map((delay) => [`${delay}ms`, summarizeSnapshot(records, `${delay}ms`)])),
        },
      };
      writeFileSync(join(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
      console.log(JSON.stringify(summary));
    }
    expect(records).toHaveLength(30);
  }, 120_000);
});
