import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCommand } from "../../src/adapters/command-runner.js";

type ProcSnapshot = {
  readonly state: string;
  readonly ppid: number | null;
  readonly pgid: number | null;
};

type DiagnosticRecord = {
  readonly iteration: number;
  readonly durationMs: number;
  readonly rootPid: number;
  readonly descendantPid: number;
  readonly rootBeforeKill: ProcSnapshot;
  readonly descendantBeforeKill: ProcSnapshot;
  readonly resultMarker: "cleanup-established" | "cleanup-failed";
  readonly rootAtReturn: ProcSnapshot;
  readonly descendantAtReturn: ProcSnapshot;
  readonly samples: Readonly<Record<string, ProcSnapshot>>;
  readonly descendantActiveAtFinal: boolean;
};

type ProcessDescriptor = {
  readonly rootPid: number;
  readonly descendantPid: number;
  readonly rootBeforeKill: ProcSnapshot;
  readonly descendantBeforeKill: ProcSnapshot;
};

function readProcSnapshot(pid: number): ProcSnapshot {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
    return {
      state: fields[0] ?? "unknown",
      ppid: Number.isInteger(Number(fields[1])) ? Number(fields[1]) : null,
      pgid: Number.isInteger(Number(fields[2])) ? Number(fields[2]) : null,
    };
  } catch {
    return { state: "missing", ppid: null, pgid: null };
  }
}

function isActive(snapshot: ProcSnapshot): boolean {
  return snapshot.state !== "missing" && snapshot.state !== "Z";
}

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

describe.skipIf(process.platform !== "linux" || process.env.DAI_LINUX_DESCENDANT_DIAGNOSTIC !== "1")("[DEBUG-LINUX-DESCENDANT-CLEANUP]", () => {
  it("records repeated descendant cleanup liveness", async () => {
    const iterations = Number(process.env.DAI_LINUX_DESCENDANT_ITERATIONS ?? "30");
    const outputPath = process.env.DAI_LINUX_DESCENDANT_OUTPUT;
    expect(Number.isInteger(iterations)).toBe(true);
    expect(iterations).toBeGreaterThanOrEqual(30);
    expect(outputPath).toBeDefined();
    const records: DiagnosticRecord[] = [];

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const root = await mkdtemp(join(tmpdir(), "d-ai-linux-cleanup-diagnostic-"));
      const descriptorPath = join(root, "processes.json");
      const script = [
        "const { spawn } = require('node:child_process');",
        "const { writeFileSync, readFileSync } = require('node:fs');",
        "const proc = (pid) => { try { const stat = readFileSync('/proc/' + pid + '/stat', 'utf8'); const end = stat.lastIndexOf(')'); const fields = stat.slice(end + 2).trim().split(/\\s+/); return { state: fields[0], ppid: Number(fields[1]), pgid: Number(fields[2]) }; } catch { return { state: 'missing', ppid: null, pgid: null }; } };",
        "const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "setTimeout(() => writeFileSync(process.argv[1], JSON.stringify({ rootPid: process.pid, descendantPid: descendant.pid, rootBeforeKill: proc(process.pid), descendantBeforeKill: proc(descendant.pid) })), 25);",
        "setInterval(() => {}, 1000);",
      ].join(" ");
      const startedAt = performance.now();
      const command = runCommand({
        command: process.execPath,
        arguments: ["-e", script, descriptorPath],
        cwd: null,
        timeoutMs: Number(process.env.DAI_LINUX_DESCENDANT_TIMEOUT_MS ?? "1000"),
      });
      let descriptor: ProcessDescriptor | undefined;
      for (let attempt = 0; attempt < 100 && descriptor === undefined; attempt += 1) {
        try {
          const parsed = JSON.parse(await readFile(descriptorPath, "utf8")) as Partial<ProcessDescriptor> | null;
          if (parsed && Number.isInteger(parsed.rootPid) && Number.isInteger(parsed.descendantPid)) descriptor = parsed as ProcessDescriptor;
        } catch {
          await sleep(5);
        }
      }
      expect(descriptor).toBeDefined();
      if (descriptor === undefined) throw new Error("Diagnostic process descriptor was not written");

      let resultMarker: DiagnosticRecord["resultMarker"] = "cleanup-failed";
      try {
        await command;
        throw new Error("Expected the diagnostic command to time out");
      } catch (error: unknown) {
        const result = (error as { result?: { stderr?: string } }).result;
        expect(result).toBeDefined();
        resultMarker = result?.stderr?.includes("Process tree cleanup could not be established")
          ? "cleanup-failed"
          : "cleanup-established";
      }
      const completedAt = performance.now();
      const rootPid = descriptor.rootPid;
      const descendantPid = descriptor.descendantPid;
      const samples: Record<string, ProcSnapshot> = {};
      const returnAt = performance.now();
      for (const delay of [5, 10, 25, 50, 100, 250, 500, 1000]) {
        const remaining = delay - (performance.now() - returnAt);
        if (remaining > 0) await sleep(remaining);
        samples[`${delay}ms`] = readProcSnapshot(descendantPid);
      }
      const finalSnapshot = samples["1000ms"] ?? { state: "missing", ppid: null, pgid: null };
      records.push({
        iteration,
        durationMs: Number((completedAt - startedAt).toFixed(3)),
        rootPid,
        descendantPid,
        rootBeforeKill: descriptor.rootBeforeKill,
        descendantBeforeKill: descriptor.descendantBeforeKill,
        resultMarker,
        rootAtReturn: readProcSnapshot(rootPid),
        descendantAtReturn: readProcSnapshot(descendantPid),
        samples,
        descendantActiveAtFinal: isActive(finalSnapshot),
      });
      if (isActive(finalSnapshot)) {
        try {
          process.kill(-rootPid, "SIGKILL");
        } catch {
          // The diagnostic remains evidence of a survivor if the final cleanup attempt fails.
        }
      }
      await writeFile(outputPath as string, `${JSON.stringify(records.at(-1))}\n`, { flag: "a" });
      await rm(root, { recursive: true, force: true });
    }

    expect(records).toHaveLength(iterations);
    const sameProcessGroup = records.filter((record) => record.rootBeforeKill.pgid !== null && record.descendantBeforeKill.pgid === record.rootBeforeKill.pgid).length;
    const cleanupEstablished = records.filter((record) => record.resultMarker === "cleanup-established").length;
    const activeAtReturn = records.filter((record) => isActive(record.descendantAtReturn)).length;
    const activeAtFinal = records.filter((record) => record.descendantActiveAtFinal).length;
    process.stdout.write(`[DEBUG-LINUX-DESCENDANT-CLEANUP] summary iterations=${records.length} sameProcessGroup=${sameProcessGroup} cleanupEstablished=${cleanupEstablished} activeAtReturn=${activeAtReturn} activeAt1000ms=${activeAtFinal}\n`);
    process.stdout.write(`[DEBUG-LINUX-DESCENDANT-CLEANUP] records=${JSON.stringify(records)}\n`);
  }, 90_000);
});
