import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { redactSensitiveText } from "../adapters/command-runner.js";
import { InvalidTaskStateError } from "../domain/errors.js";
import {
  runRepositoryHealthCheck,
  type RepositoryHealthReport,
} from "./repository-health-check.js";

export interface HealthCheckCLIResult {
  readonly exitCode: 0 | 1 | 2;
  readonly report: RepositoryHealthReport;
}

function parseArguments(arguments_: readonly string[]): { readonly workspacePath: string; readonly structuralOnly: boolean } {
  if ((arguments_.length !== 2 && arguments_.length !== 3) || arguments_[0] !== "--workspace" || (arguments_.length === 3 && arguments_[2] !== "--structural-only")) {
    throw new InvalidTaskStateError("Health check requires --workspace <path> and optionally --structural-only");
  }
  const workspacePath = arguments_[1];
  if (workspacePath === undefined || workspacePath.trim().length === 0) {
    throw new InvalidTaskStateError("Health check requires a non-empty --workspace <path> argument");
  }
  return { workspacePath: resolve(workspacePath), structuralOnly: arguments_[2] === "--structural-only" };
}

function exitCodeForStatus(status: RepositoryHealthReport["status"]): 0 | 1 | 2 {
  if (status === "healthy") return 0;
  if (status === "unhealthy") return 1;
  return 2;
}

function redactReport(report: RepositoryHealthReport): RepositoryHealthReport {
  return {
    ...report,
    workspacePath: redactSensitiveText(report.workspacePath),
    checks: report.checks.map((check) => ({
      ...check,
      observation: redactSensitiveText(check.observation),
    })),
  };
}

function blockedReport(workspacePath: string, error: unknown): RepositoryHealthReport {
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  return {
    status: "blocked",
    workspacePath: redactSensitiveText(workspacePath),
    checks: [{ id: "cli", status: "blocked", observation: message }],
  };
}

export async function runHealthCheckCLI(arguments_: readonly string[]): Promise<HealthCheckCLIResult> {
  const { workspacePath, structuralOnly } = parseArguments(arguments_);
  try {
    const report = redactReport(await runRepositoryHealthCheck({ workspacePath, structuralOnly }));
    return { exitCode: exitCodeForStatus(report.status), report };
  } catch (error: unknown) {
    const report = blockedReport(workspacePath, error);
    return { exitCode: 2, report };
  }
}

async function runMain(): Promise<void> {
  let result: HealthCheckCLIResult;
  try {
    result = await runHealthCheckCLI(process.argv.slice(2));
  } catch (error: unknown) {
    const report = blockedReport("", error);
    result = { exitCode: 2, report };
  }
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  process.exitCode = result.exitCode;
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath !== null && invokedPath === resolve(fileURLToPath(import.meta.url))) {
  await runMain();
}
