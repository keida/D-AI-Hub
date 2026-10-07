import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/adapters/command-runner.js";
import type { TaskCharter, TaskState } from "../../src/domain/types.js";
import { resolveDefaultMemoryDatabasePath } from "../../src/memory/local-memory-path.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { taskCharterContentDigest, taskCharterTaskId } from "../../src/state/task-charter.js";

interface CLIResult {
  readonly exitCode: number;
  readonly response: {
    readonly taskId: string;
    readonly status: string;
    readonly message: string;
    readonly stage?: string;
    readonly environment?: string;
    readonly taskCharter?: TaskCharter;
  };
  readonly stdout: string;
  readonly stderr: string;
}

function charter(projectIdentity: string): TaskCharter {
  const content = {
    schemaVersion: 1 as const,
    charterId: "initial-registration-integration",
    charterVersion: "1",
    projectIdentity,
    objective: "Register the approved initial project task",
    ownedScope: ["one synthetic project task"],
    excludedScope: ["historical tasks and unrelated workspaces"],
    completionCriteria: ["the task is durably discoverable after restart"],
    terminationCondition: "Stop after initial registration and read-back checks.",
    initialNextAction: "Inspect the synthetic project and select one safe next step.",
  };
  return {
    ...content,
    approval: {
      confirmation: "I_APPROVE_THIS_TASK_CHARTER",
      approvedBy: "synthetic-integration-operator",
      approvedAt: "2026-10-07T00:00:00.000Z",
      approvalReference: "synthetic initial registration approval",
      projectIdentity,
      approvedCharterDigest: taskCharterContentDigest(content),
    },
  };
}

async function runProcess(command: string, arguments_: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...arguments_], { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (exitCode === null) reject(new Error(`Process ended without an exit code: ${stderr}`));
      else resolvePromise({ exitCode, stdout, stderr });
    });
  });
}

async function runGit(root: string, ...arguments_: string[]): Promise<void> {
  const result = await runProcess("git", arguments_, root, {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(root, "synthetic-gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
  });
  if (result.exitCode !== 0) throw new Error(`Synthetic git ${arguments_[0]} failed (${result.exitCode}): ${result.stderr}`);
}

async function gitOutput(root: string, ...arguments_: string[]): Promise<string> {
  const result = await runProcess("git", arguments_, root, {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  });
  if (result.exitCode !== 0) throw new Error(`Synthetic git ${arguments_[0]} failed (${result.exitCode}): ${result.stderr}`);
  return result.stdout;
}

async function snapshotGitState(root: string): Promise<{
  readonly head: string;
  readonly index: Buffer;
  readonly stagedDiff: string;
  readonly unstagedDiff: string;
  readonly status: string;
}> {
  return {
    head: await gitOutput(root, "rev-parse", "HEAD"),
    index: await readFile(join(root, ".git", "index")),
    stagedDiff: await gitOutput(root, "diff", "--cached", "--binary"),
    unstagedDiff: await gitOutput(root, "diff", "--binary"),
    status: await gitOutput(root, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

async function snapshotFiles(root: string): Promise<readonly (readonly [string, Buffer])[]> {
  const files: Array<readonly [string, Buffer]> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push([relative(root, path), await readFile(path)]);
    }
  };
  await visit(root);
  return files;
}

function parseCLIResult(exitCode: number, stdout: string, stderr: string): CLIResult {
  let response: CLIResult["response"];
  try { response = JSON.parse(stdout) as CLIResult["response"]; }
  catch { throw new Error(`Synthetic CLI returned non-JSON output (exit ${exitCode}): ${stderr}\n${stdout}`); }
  return { exitCode, response, stdout, stderr };
}

const explicitApprovalErrorMessage = "Task charter file and explicit --approve-task-charter digest must be supplied together";

function parseSingleCLIErrorLine(stderr: string): Record<string, unknown> {
  const jsonLines = stderr.split(/\r?\n/u).filter((line) => {
    const candidate = line.trimStart();
    if (candidate.startsWith("{")) return true;
    if (!candidate.startsWith("[")) return false;
    return !/^\[[A-Z][A-Z0-9_]*\]\s+[A-Za-z]*Warning:/u.test(candidate);
  });
  if (jsonLines.length === 0) throw new Error("CLI stderr did not contain a full-line JSON record");
  if (jsonLines.length !== 1) throw new Error("CLI stderr contains multiple full-line JSON records");

  let parsed: unknown;
  try { parsed = JSON.parse(jsonLines[0]!); }
  catch { throw new Error("CLI stderr contains malformed full-line JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CLI error JSON has an unexpected structure");
  }
  if (JSON.stringify(parsed) !== jsonLines[0]) throw new Error("CLI stderr JSON record is not compact");

  const response = parsed as Record<string, unknown>;
  if (response.status !== "blocked" || response.environment !== "codex" || response.message !== explicitApprovalErrorMessage) {
    throw new Error("CLI error JSON did not match the explicit-approval refusal contract");
  }
  return response;
}

const cliErrorParserCases: readonly { readonly name: string; readonly stderr: string; readonly accepted: boolean }[] = [
  { name: "one full JSON line without a warning", stderr: `${JSON.stringify({ status: "blocked", environment: "codex", message: explicitApprovalErrorMessage })}\n`, accepted: true },
  { name: "one full JSON line after raw Node warnings", stderr: `(node:31415) ExperimentalWarning: diagnostic {"status":"warning"}\n[MODULE_TYPELESS_PACKAGE_JSON] Warning: module type is unspecified\n${JSON.stringify({ status: "blocked", environment: "codex", message: explicitApprovalErrorMessage })}\n`, accepted: true },
  { name: "noncompact full-line JSON", stderr: '{"status": "blocked", "environment": "codex", "message": "Task charter file and explicit --approve-task-charter digest must be supplied together"}\n', accepted: false },
  { name: "missing JSON record", stderr: "(node:31415) ExperimentalWarning: diagnostic only\n", accepted: false },
  { name: "malformed full-line JSON", stderr: '{"status":"blocked","environment":}\n', accepted: false },
  { name: "duplicate full-line JSON records", stderr: `${JSON.stringify({ status: "blocked", environment: "codex", message: explicitApprovalErrorMessage })}\n${JSON.stringify({ status: "blocked", environment: "codex", message: explicitApprovalErrorMessage })}\n`, accepted: false },
  { name: "standalone JSON array record", stderr: "[]\n", accepted: false },
  { name: "expected object followed by JSON array record", stderr: `${JSON.stringify({ status: "blocked", environment: "codex", message: explicitApprovalErrorMessage })}\n[]\n`, accepted: false },
  { name: "expected object followed by malformed JSON object", stderr: `${JSON.stringify({ status: "blocked", environment: "codex", message: explicitApprovalErrorMessage })}\n{"status":}\n`, accepted: false },
  { name: "wrong JSON structure", stderr: `${JSON.stringify({ status: "blocked", message: explicitApprovalErrorMessage })}\n`, accepted: false },
  { name: "wrong error message", stderr: `${JSON.stringify({ status: "blocked", environment: "codex", message: "different refusal" })}\n`, accepted: false },
];

describe("single full-line CLI error parsing", () => {
  it.each(cliErrorParserCases)("$name", ({ stderr, accepted }) => {
    if (accepted) {
      expect(parseSingleCLIErrorLine(stderr)).toMatchObject({
        status: "blocked",
        environment: "codex",
        message: explicitApprovalErrorMessage,
      });
    } else {
      expect(() => parseSingleCLIErrorLine(stderr)).toThrow();
    }
  });
});

function isPathWithin(root: string, path: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function summarizeSnapshot(snapshot: readonly (readonly [string, Buffer])[]): readonly { readonly path: string; readonly bytes: number; readonly sha256: string }[] {
  return snapshot.map(([path, contents]) => ({
    path,
    bytes: contents.length,
    sha256: createHash("sha256").update(contents).digest("hex"),
  }));
}

function activePointerRecords(snapshot: readonly (readonly [string, Buffer])[]): readonly { readonly path: string; readonly value: unknown }[] {
  return snapshot
    .filter(([path]) => path.split(sep).includes("active") && path.endsWith(".json"))
    .map(([path, contents]) => ({ path, value: JSON.parse(contents.toString("utf8")) as unknown }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function withoutOwnershipMetadata(snapshot: readonly (readonly [string, Buffer])[]): readonly (readonly [string, Buffer])[] {
  return snapshot.filter(([path]) => !path.split(sep).includes("ownership"));
}

function changedOwnershipFiles(
  before: readonly (readonly [string, Buffer])[],
  after: readonly (readonly [string, Buffer])[],
): readonly string[] {
  const prior = new Map(before.filter(([path]) => path.split(sep).includes("ownership")));
  const current = new Map(after.filter(([path]) => path.split(sep).includes("ownership")));
  return [...new Set([...prior.keys(), ...current.keys()])]
    .filter((path) => {
      const priorContents = prior.get(path);
      const currentContents = current.get(path);
      return priorContents === undefined ? currentContents !== undefined : currentContents === undefined || !priorContents.equals(currentContents);
    })
    .sort();
}

function repositoryTaskState(taskId: string, goal: string, projectIdentity: string): TaskState {
  return {
    taskId,
    goal,
    constraints: [],
    environment: "codex",
    stage: "bootstrap",
    role: "analyst",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: [
      `identity:workspace:C:/synthetic/workspace:${"1".repeat(64)}`,
      `identity:repository:C:/synthetic/repository:${"2".repeat(64)}`,
      projectIdentity,
    ],
    handoffState: "none",
    verificationEvidence: [],
    recoveryPoint: null,
    approvalState: "not-required",
    criticalUnsavedContext: [],
    durableContext: null,
  };
}

describe("approved charter initial registration CLI integration", () => {
  it("registers the first approved charter in an empty synthetic Git workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-charter-initial-"));
    const workspacePath = join(root, "workspace");
    const appDataPath = join(root, "isolated-appdata");
    const charterPath = join(root, "approved-charter.json");
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const cliPath = join(repositoryRoot, "src", "entry", "codex-cli.ts");
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await runGit(workspacePath, "init", "--initial-branch=main");
      await runGit(workspacePath, "config", "user.name", "Synthetic Integration");
      await runGit(workspacePath, "config", "user.email", "synthetic@example.invalid");
      await writeFile(join(workspacePath, "README.md"), "synthetic fixture\n", "utf8");
      await writeFile(join(workspacePath, ".gitignore"), ".d-ai/\n", "utf8");
      await runGit(workspacePath, "add", "README.md", ".gitignore");
      await runGit(workspacePath, "commit", "-m", "synthetic fixture");
      await runGit(workspacePath, "remote", "add", "origin", "https://github.com/example/initial-registration-fixture.git");
      await writeFile(join(workspacePath, "staged-fixture.txt"), "staged synthetic content\n", "utf8");
      await runGit(workspacePath, "add", "staged-fixture.txt");
      await writeFile(join(workspacePath, "README.md"), "synthetic unstaged change\n", "utf8");
      await writeFile(join(workspacePath, "untracked-fixture.txt"), "untracked synthetic content\n", "utf8");

      const projectIdentity = "remote-repository:github.com/example/initial-registration-fixture";
      const approvedCharter = charter(projectIdentity);
      const approvedDigest = taskCharterContentDigest(approvedCharter);
      await writeFile(charterPath, JSON.stringify(approvedCharter), "utf8");
      const isolatedEnvironment = {
        ...process.env,
        D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "synthetic-gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        ...(process.platform === "win32" ? { LOCALAPPDATA: appDataPath } : { XDG_DATA_HOME: appDataPath }),
      };
      const memoryDatabasePath = resolveDefaultMemoryDatabasePath(isolatedEnvironment);
      const appDataRelative = relative(resolve(appDataPath), memoryDatabasePath);
      expect(isAbsolute(memoryDatabasePath)).toBe(true);
      expect(appDataRelative === "" || (!appDataRelative.startsWith(`..${sep}`) && appDataRelative !== ".." && !isAbsolute(appDataRelative))).toBe(true);
      expect(existsSync(join(workspacePath, ".d-ai"))).toBe(false);

      const wrongProjectCharter = charter("remote-repository:github.com/example/wrong-project");
      const wrongProjectPath = join(root, "wrong-project-charter.json");
      await writeFile(wrongProjectPath, JSON.stringify(wrongProjectCharter), "utf8");
      const wrongProjectResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath,
        "--command", "@D-AI establish wrong project fixture",
        "--task-charter-file", wrongProjectPath,
        "--approve-task-charter", taskCharterContentDigest(wrongProjectCharter),
      ], repositoryRoot, isolatedEnvironment);
      expect(parseCLIResult(wrongProjectResult.exitCode, wrongProjectResult.stdout, wrongProjectResult.stderr)).toMatchObject({
        exitCode: 2,
        response: { status: "blocked", message: expect.stringContaining("must exactly match") },
      });

      const wrongApprovalPath = join(root, "wrong-approval-charter.json");
      await writeFile(wrongApprovalPath, JSON.stringify({
        ...approvedCharter,
        approval: { ...approvedCharter.approval, approvedCharterDigest: "0".repeat(64) },
      }), "utf8");
      const wrongApprovalResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath,
        "--command", "@D-AI establish wrong approval fixture",
        "--task-charter-file", wrongApprovalPath,
        "--approve-task-charter", approvedDigest,
      ], repositoryRoot, isolatedEnvironment);
      expect(parseCLIResult(wrongApprovalResult.exitCode, wrongApprovalResult.stdout, wrongApprovalResult.stderr)).toMatchObject({
        exitCode: 2,
        response: { status: "blocked", message: expect.stringContaining("approval does not bind") },
      });
      expect(existsSync(join(workspacePath, ".d-ai"))).toBe(false);

      const missingExplicitApprovalResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath,
        "--command", "@D-AI establish missing explicit approval fixture",
        "--task-charter-file", charterPath,
      ], repositoryRoot, isolatedEnvironment);
      expect(missingExplicitApprovalResult.exitCode).toBe(2);
      expect(missingExplicitApprovalResult.stdout).toBe("");
      expect(parseSingleCLIErrorLine(missingExplicitApprovalResult.stderr)).toMatchObject({
        status: "blocked",
        environment: "codex",
        message: explicitApprovalErrorMessage,
      });

      const wrongExplicitApprovalResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath,
        "--command", "@D-AI establish wrong explicit approval fixture",
        "--task-charter-file", charterPath,
        "--approve-task-charter", "0".repeat(64),
      ], repositoryRoot, isolatedEnvironment);
      expect(parseCLIResult(wrongExplicitApprovalResult.exitCode, wrongExplicitApprovalResult.stdout, wrongExplicitApprovalResult.stderr)).toMatchObject({
        exitCode: 2,
        response: { status: "blocked", message: expect.stringContaining("does not match") },
      });

      const invalidGitWorkspace = join(root, ".git-invalid");
      await mkdir(invalidGitWorkspace, { recursive: true });
      await mkdir(join(invalidGitWorkspace, ".agents", "skills"), { recursive: true });
      await runGit(invalidGitWorkspace, "init", "--initial-branch=main");
      const invalidGitResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", invalidGitWorkspace,
        "--command", "@D-AI establish invalid Git identity fixture",
        "--task-charter-file", charterPath,
        "--approve-task-charter", approvedDigest,
      ], repositoryRoot, isolatedEnvironment);
      expect(parseCLIResult(invalidGitResult.exitCode, invalidGitResult.stdout, invalidGitResult.stderr)).toMatchObject({
        exitCode: 2,
        response: { status: "blocked" },
      });
      expect(existsSync(join(invalidGitWorkspace, ".d-ai"))).toBe(false);
      expect(existsSync(join(workspacePath, ".d-ai"))).toBe(false);

      const cliArgs = ["--import", "tsx", cliPath,
        "--workspace", workspacePath,
        "--command", "@D-AI establish initial registered project",
        "--task-charter-file", charterPath,
        "--approve-task-charter", approvedDigest,
      ];
      const gitBeforeRegistration = await snapshotGitState(workspacePath);
      const result = await runProcess(process.execPath, cliArgs, repositoryRoot, isolatedEnvironment);
      const cli = parseCLIResult(result.exitCode, result.stdout, result.stderr);
      expect(cli, cli.response.message).toMatchObject({
        exitCode: 0,
        response: {
          taskId: taskCharterTaskId(projectIdentity, approvedDigest),
          status: "accepted",
          stage: "bootstrap",
          taskCharter: approvedCharter,
          message: expect.stringContaining("approved project task"),
        },
      });
      const store = new FileDurableContextStore(join(workspacePath, ".d-ai"));
      expect(await store.load(cli.response.taskId)).toMatchObject({
        stage: "bootstrap",
        routingDisposition: "ROUTABLE",
        taskCharter: approvedCharter,
        verificationEvidence: [],
      });
      expect(await snapshotGitState(workspacePath)).toEqual(gitBeforeRegistration);

      const repeatedResult = await runProcess(process.execPath, cliArgs, repositoryRoot, isolatedEnvironment);
      const repeated = parseCLIResult(repeatedResult.exitCode, repeatedResult.stdout, repeatedResult.stderr);
      expect(repeated).toMatchObject({
        exitCode: 0,
        response: { taskId: cli.response.taskId, status: "accepted", taskCharter: approvedCharter },
      });

      const statusResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath, "--command", "@D-AI status",
      ], repositoryRoot, isolatedEnvironment);
      expect(parseCLIResult(statusResult.exitCode, statusResult.stdout, statusResult.stderr)).toMatchObject({
        exitCode: 0,
        response: { taskId: cli.response.taskId, status: "accepted", taskCharter: approvedCharter },
      });

      const detachedWorkspace = join(root, "detached-worktree");
      await runGit(workspacePath, "worktree", "add", "--detach", detachedWorkspace, "HEAD");
      expect(existsSync(join(detachedWorkspace, ".d-ai"))).toBe(false);
      const attachedDurableBeforeDetachedRegistration = await snapshotFiles(join(workspacePath, ".d-ai"));
      const detachedResult = await runProcess(process.execPath, cliArgs.map((argument) => argument === workspacePath ? detachedWorkspace : argument), repositoryRoot, isolatedEnvironment);
      expect(parseCLIResult(detachedResult.exitCode, detachedResult.stdout, detachedResult.stderr)).toMatchObject({
        exitCode: 0,
        response: { taskId: cli.response.taskId, status: "accepted", stage: "bootstrap", taskCharter: approvedCharter },
      });
      expect((await new FileDurableContextStore(join(detachedWorkspace, ".d-ai")).load(cli.response.taskId))?.taskCharter).toEqual(approvedCharter);
      expect((await readdir(join(workspacePath, ".d-ai"))).filter((entry) => entry.startsWith("task-") )).toEqual([cli.response.taskId]);
      expect(await snapshotFiles(join(workspacePath, ".d-ai"))).toEqual(attachedDurableBeforeDetachedRegistration);

      const createdTask = await store.load(cli.response.taskId);
      if (createdTask === null) throw new Error("Attached initial task disappeared before closed-history check");
      await store.withTaskOwnership!(createdTask.taskId, createdTask.environment, async (lease) => {
        await store.save({ ...createdTask, stage: "close", durableContext: null }, lease);
      });
      const closedStatePath = join(workspacePath, ".d-ai", cli.response.taskId, "state.json");
      const closedStateBytes = await readFile(closedStatePath);
      const closedRepeatResult = await runProcess(process.execPath, cliArgs, repositoryRoot, isolatedEnvironment);
      expect(parseCLIResult(closedRepeatResult.exitCode, closedRepeatResult.stdout, closedRepeatResult.stderr)).toMatchObject({
        exitCode: 2,
        response: { status: "blocked", message: expect.stringContaining("history") },
      });
      expect(await readFile(closedStatePath)).toEqual(closedStateBytes);
      expect(await readFile(charterPath, "utf8")).toBe(JSON.stringify(approvedCharter));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 90_000);

  it("serializes approved initial admission against ordinary createIfAbsent in both cross-process orders", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-initial-admission-race-"));
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const cliPath = join(repositoryRoot, "src", "entry", "codex-cli.ts");
    const storeModuleUrl = new URL("../../src/state/file-durable-context-store.ts", import.meta.url).href;
    const childScript = `
      import { access, writeFile } from "node:fs/promises";
      const { FileDurableContextStore } = await import(${JSON.stringify(storeModuleUrl)});
      const { TaskOwnershipError } = await import(${JSON.stringify(new URL("../../src/domain/errors.ts", import.meta.url).href)});
      const { DAI_TEST_ROOT: rootPath, DAI_TEST_STATE: statePath, DAI_TEST_MODE: mode, DAI_TEST_PAUSE_MODE: pauseMode, DAI_TEST_PAUSED: pausedPath, DAI_TEST_RELEASE: releasePath, DAI_TEST_CONTENDED: contendedPath, DAI_TEST_PROJECT: project } = process.env;
      const pause = async () => {
        await writeFile(pausedPath, "paused", "utf8");
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          try { await access(releasePath); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
        }
        throw new Error("initial-admission test barrier timed out");
      };
      const hooks = {
        afterInitialCompanionsWritten: mode === pauseMode ? pause : undefined,
        afterRootAdmissionContended: async () => writeFile(contendedPath, "contended", "utf8"),
      };
      try {
        const state = JSON.parse(await (await import("node:fs/promises")).readFile(statePath, "utf8"));
        const store = new FileDurableContextStore(rootPath, hooks);
        const manifest = mode === "charter"
          ? await store.createInitialProjectTaskIfEmpty(state, project)
          : await store.createIfAbsent(state);
        process.stdout.write(JSON.stringify({ kind: manifest === null ? "occupied" : "created", taskId: manifest?.taskId ?? null }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ kind: "blocked", errorName: error instanceof Error ? error.name : typeof error, expectedContentionError: error instanceof TaskOwnershipError, message: error instanceof Error ? error.message : String(error) }));
      }
    `;
    const waitForFile = async (path: string): Promise<void> => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      throw new Error("Cross-process initial-admission barrier timed out");
    };
    const runOrdering = async (ordering: "charter-first" | "ordinary-first", suffix: string) => {
      const scenarioRoot = join(root, ordering);
      const workspaceRoot = join(scenarioRoot, "workspace");
      const durableRoot = join(workspaceRoot, ".d-ai");
      await mkdir(workspaceRoot, { recursive: true });
      await mkdir(join(workspaceRoot, ".agents", "skills"), { recursive: true });
      const isolatedLocalAppData = join(scenarioRoot, "isolated-localappdata");
      const isolatedXdgDataHome = join(scenarioRoot, "isolated-xdg-data");
      const isolatedHome = join(scenarioRoot, "isolated-home");
      const memoryDatabasePath = join(scenarioRoot, "isolated-memory.sqlite");
      const isolatedMemoryEnvironment = {
        ...process.env,
        LOCALAPPDATA: isolatedLocalAppData,
        XDG_DATA_HOME: isolatedXdgDataHome,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
      };
      const defaultMemoryPath = resolveDefaultMemoryDatabasePath(isolatedMemoryEnvironment);
      const defaultMemoryRelative = relative(resolve(scenarioRoot), resolve(defaultMemoryPath));
      expect(defaultMemoryRelative === "" || (!defaultMemoryRelative.startsWith(`..${sep}`)
        && defaultMemoryRelative !== ".." && !isAbsolute(defaultMemoryRelative))).toBe(true);
      await runGit(workspaceRoot, "init", "--initial-branch=main");
      await runGit(workspaceRoot, "config", "user.name", "Synthetic Integration");
      await runGit(workspaceRoot, "config", "user.email", "synthetic@example.invalid");
      await writeFile(join(workspaceRoot, "README.md"), "synthetic fixture\n", "utf8");
      await runGit(workspaceRoot, "add", "README.md");
      await runGit(workspaceRoot, "commit", "-m", "synthetic fixture");
      const projectIdentity = `remote-repository:github.com/example/atomic-${suffix}`;
      await runGit(workspaceRoot, "remote", "add", "origin", `https://github.com/example/atomic-${suffix}.git`);
      const workspacePath = await realpath(workspaceRoot);
      const ordinaryStatePath = join(scenarioRoot, "ordinary-state.json");
      const charterStatePath = join(scenarioRoot, "charter-state.json");
      const pausedPath = join(scenarioRoot, "paused");
      const releasePath = join(scenarioRoot, "release");
      const contendedPath = join(scenarioRoot, "contended");
      const bindWorkspace = (state: TaskState): TaskState => ({
        ...state,
        contextManifest: state.contextManifest.map((entry) => entry.startsWith("identity:workspace:")
          ? `identity:workspace:${workspacePath}:${"1".repeat(64)}`
          : entry),
      });
      const ordinaryState = bindWorkspace(repositoryTaskState(`task-${suffix[0]!.repeat(24)}`, "ordinary initial task", projectIdentity));
      const approvedCharter = charter(projectIdentity);
      const digest = taskCharterContentDigest(approvedCharter);
      const charterState: TaskState = bindWorkspace({
        ...repositoryTaskState(taskCharterTaskId(projectIdentity, digest), approvedCharter.objective, projectIdentity),
        routingDisposition: "ROUTABLE",
        taskCharter: approvedCharter,
        taskCharterConfirmation: {
          confirmationId: `00000000-0000-4000-8000-${suffix[1]!.repeat(12)}`,
          confirmedAt: "2026-10-07T00:00:00.000Z",
          projectIdentity,
          confirmedCharterDigest: digest,
          channel: "explicit-task-charter-digest",
        },
      });
      await writeFile(ordinaryStatePath, JSON.stringify(ordinaryState), "utf8");
      await writeFile(charterStatePath, JSON.stringify(charterState), "utf8");
      const pausedMode = ordering === "charter-first" ? "charter" : "ordinary";
      const firstMode = pausedMode;
      const firstStatePath = firstMode === "charter" ? charterStatePath : ordinaryStatePath;
      const firstPromise = runProcess(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], repositoryRoot, {
        ...process.env,
        LOCALAPPDATA: join(scenarioRoot, "isolated-localappdata"),
        DAI_TEST_ROOT: durableRoot,
        DAI_TEST_STATE: firstStatePath,
        DAI_TEST_MODE: firstMode,
        DAI_TEST_PAUSE_MODE: pausedMode,
        DAI_TEST_PAUSED: pausedPath,
        DAI_TEST_RELEASE: releasePath,
        DAI_TEST_CONTENDED: contendedPath,
        DAI_TEST_PROJECT: projectIdentity,
      });
      void firstPromise.catch(() => undefined);
      try {
        await waitForFile(pausedPath);
        const secondMode = firstMode === "charter" ? "ordinary" : "charter";
        const secondStatePath = secondMode === "charter" ? charterStatePath : ordinaryStatePath;
        const second = await runProcess(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], repositoryRoot, {
          ...process.env,
          LOCALAPPDATA: join(scenarioRoot, "isolated-localappdata"),
          DAI_TEST_ROOT: durableRoot,
          DAI_TEST_STATE: secondStatePath,
          DAI_TEST_MODE: secondMode,
          DAI_TEST_PAUSE_MODE: pausedMode,
          DAI_TEST_PAUSED: join(scenarioRoot, "other-paused"),
          DAI_TEST_RELEASE: join(scenarioRoot, "other-release"),
          DAI_TEST_CONTENDED: contendedPath,
          DAI_TEST_PROJECT: projectIdentity,
        });
        await writeFile(releasePath, "release", "utf8");
        const first = await firstPromise;
        const outcomes = {
          first: JSON.parse(first.stdout) as { kind: string; taskId: string | null; errorName?: string; expectedContentionError?: boolean; message?: string },
          second: JSON.parse(second.stdout) as { kind: string; taskId: string | null; errorName?: string; expectedContentionError?: boolean; message?: string },
          firstExitCode: first.exitCode,
          secondExitCode: second.exitCode,
          contended: await access(contendedPath).then(() => true, () => false),
          taskIds: (await readdir(durableRoot)).filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry)).sort(),
          electionDirectoryPresent: await access(join(durableRoot, ".project-successor-election")).then(() => true, () => false),
        };
        const firstState = firstMode === "charter" ? charterState : ordinaryState;
        const store = new FileDurableContextStore(durableRoot);
        const published = await store.load(firstState.taskId);
        const manifest = published?.durableContext ?? null;
        const generation = manifest === null ? null : await store.loadGenerationManifest(firstState.taskId, manifest.manifestId);
        const activeTasks = await store.discoverActiveTasks(workspacePath);
        const projectKey = createHash("sha256").update(`dai-project-election-v1\n${projectIdentity}`, "utf8").digest("hex");
        const contenderDirectory = join(durableRoot, ".project-successor-election", projectKey, "contenders");
        const contenderFiles = await access(contenderDirectory).then(() => readdir(contenderDirectory), () => [] as string[]);
        const contenders = await Promise.all(contenderFiles.map(async (file) =>
          JSON.parse(await readFile(join(contenderDirectory, file), "utf8")) as { taskId: string; charterDigest: string; candidateKind?: string }));
        let ownershipReadback = false;
        await store.withTaskOwnership!(firstState.taskId, firstState.environment, async (lease) => {
          const current = await store.load(firstState.taskId);
          ownershipReadback = lease.taskId === firstState.taskId && lease.environment === firstState.environment
            && current?.taskId === firstState.taskId;
        });
        const statusResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
          "--workspace", workspacePath, "--command", "@D-AI status",
          "--memory-database", memoryDatabasePath,
        ], repositoryRoot, {
          ...isolatedMemoryEnvironment,
          D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED: "0",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, "synthetic-gitconfig"),
          GIT_TERMINAL_PROMPT: "0",
        });
        const status = parseCLIResult(statusResult.exitCode, statusResult.stdout, statusResult.stderr);
        const statusReadback = { exitCode: status.exitCode, taskId: status.response.taskId, status: status.response.status, message: status.response.message };
        const strictReadback = {
          taskId: published?.taskId ?? null,
          manifestId: manifest?.manifestId ?? null,
          generationMatches: generation !== null && JSON.stringify(generation) === JSON.stringify(manifest),
          activeTaskIds: activeTasks.map((task) => task.taskId),
          contenderTaskIds: contenders.map((contender) => contender.taskId),
          contenderCount: contenders.length,
          noElectionConflict: !await store.hasProjectSuccessorConflict(projectIdentity),
          ownershipReadback,
        };
        return { ...outcomes, strictReadback, statusReadback, expectedTaskId: firstState.taskId };
      } finally {
        await writeFile(releasePath, "release", "utf8").catch(() => undefined);
        await firstPromise.catch(() => undefined);
      }
    };
    try {
      const charterFirst = await runOrdering("charter-first", "a1");
      const ordinaryFirst = await runOrdering("ordinary-first", "b2");
      for (const [ordering, scenario] of [["charter-first", charterFirst], ["ordinary-first", ordinaryFirst]] as const) {
        const redactedMessage = redactSensitiveText(scenario.statusReadback.message);
        const messageLimit = 320;
        console.info("[initial-admission-status-readback]", JSON.stringify({
          ordering,
          expectedTaskId: scenario.expectedTaskId,
          strictActiveTaskIds: scenario.strictReadback.activeTaskIds,
          statusExitCode: scenario.statusReadback.exitCode,
          status: scenario.statusReadback.status,
          taskId: scenario.statusReadback.taskId,
          message: {
            preview: redactedMessage.slice(0, messageLimit),
            truncated: redactedMessage.length > messageLimit,
            originalRedactedLength: redactedMessage.length,
            retainedRange: { start: 0, endExclusive: Math.min(redactedMessage.length, messageLimit) },
          },
        }));
      }
      expect({ charterFirst, ordinaryFirst }).toMatchObject({
        charterFirst: {
          first: { kind: "created" },
          second: { kind: "blocked", errorName: "TaskOwnershipError", expectedContentionError: true, message: "Another durable task is being admitted at this root" },
          firstExitCode: 0,
          secondExitCode: 0,
          contended: true,
          taskIds: [charterFirst.first.taskId],
          strictReadback: {
            taskId: charterFirst.expectedTaskId,
            generationMatches: true,
            activeTaskIds: [charterFirst.expectedTaskId],
            contenderTaskIds: [charterFirst.expectedTaskId],
            contenderCount: 1,
            noElectionConflict: true,
            ownershipReadback: true,
          },
          statusReadback: { exitCode: 0, taskId: charterFirst.expectedTaskId, status: "accepted" },
        },
        ordinaryFirst: {
          first: { kind: "created" },
          second: { kind: "blocked", errorName: "TaskOwnershipError", expectedContentionError: true, message: "Another durable task is being admitted at this root" },
          firstExitCode: 0,
          secondExitCode: 0,
          contended: true,
          taskIds: [ordinaryFirst.first.taskId],
          electionDirectoryPresent: false,
          strictReadback: {
            taskId: ordinaryFirst.expectedTaskId,
            generationMatches: true,
            activeTaskIds: [ordinaryFirst.expectedTaskId],
            contenderTaskIds: [],
            contenderCount: 0,
            noElectionConflict: true,
            ownershipReadback: true,
          },
          statusReadback: { exitCode: 0, taskId: ordinaryFirst.expectedTaskId, status: "accepted" },
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 90_000);

  it("fences ordinary-establish versus approved-charter admission at the store boundary across independent processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-charter-initial-race-"));
    const durableRoot = join(root, "durable");
    const projectIdentity = "remote-repository:github.com/example/initial-race-fixture";
    const operatorStatePath = join(root, "ordinary-state.json");
    const charterStatePath = join(root, "charter-state.json");
    const readyPath = join(root, "ordinary-ready");
    const releasePath = join(root, "ordinary-release");
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const storeModuleUrl = new URL("../../src/state/file-durable-context-store.ts", import.meta.url).href;
    let firstPromise: Promise<{ exitCode: number; stdout: string; stderr: string }> | null = null;
    try {
      const ordinary = repositoryTaskState(`task-${"e".repeat(24)}`, "ordinary establish race", projectIdentity);
      const approvedCharter = charter(projectIdentity);
      const digest = taskCharterContentDigest(approvedCharter);
      const charterState: TaskState = {
        ...repositoryTaskState(taskCharterTaskId(projectIdentity, digest), approvedCharter.objective, projectIdentity),
        routingDisposition: "ROUTABLE",
        taskCharter: approvedCharter,
        taskCharterConfirmation: {
          confirmationId: "00000000-0000-4000-8000-000000000002",
          confirmedAt: "2026-10-07T00:00:00.000Z",
          projectIdentity,
          confirmedCharterDigest: digest,
          channel: "explicit-task-charter-digest",
        },
      };
      await writeFile(operatorStatePath, JSON.stringify(ordinary), "utf8");
      await writeFile(charterStatePath, JSON.stringify(charterState), "utf8");

      const childScript = `
        import { access, readFile, writeFile } from "node:fs/promises";
        const { FileDurableContextStore } = await import(${JSON.stringify(storeModuleUrl)});
        const { DAI_TEST_ROOT: rootPath, DAI_TEST_STATE: statePath, DAI_TEST_READY: ready, DAI_TEST_RELEASE: release, DAI_TEST_PAUSE: shouldPause, DAI_TEST_PROJECT: project } = process.env;
        const state = JSON.parse(await readFile(statePath, "utf8"));
        const pause = async () => {
          await writeFile(ready, "ready", "utf8");
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            try { await access(release); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
          }
          throw new Error("cross-process admission barrier timed out");
        };
        const hooks = {
          afterProjectContenderRegistered: shouldPause === "1" ? pause : undefined,
        };
        try {
          const manifest = await new FileDurableContextStore(rootPath, hooks).createInitialProjectTaskIfEmpty(state, project);
          process.stdout.write(JSON.stringify({ kind: manifest === null ? "occupied" : "created", taskId: manifest?.taskId ?? null }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          process.stdout.write(JSON.stringify({ kind: message.includes("barrier timed out") ? "error" : "blocked", message }));
        }
      `;
      const baseEnvironment = {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        DAI_TEST_ROOT: durableRoot,
        DAI_TEST_PROJECT: projectIdentity,
        DAI_TEST_READY: readyPath,
        DAI_TEST_RELEASE: releasePath,
        DAI_TEST_PAUSE: "1",
      };
      firstPromise = runProcess(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], repositoryRoot, {
        ...baseEnvironment, DAI_TEST_STATE: operatorStatePath,
      });
      const barrierDeadline = Date.now() + 20_000;
      while (Date.now() < barrierDeadline) {
        try { await access(readyPath); break; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 10)); }
      }
      expect(await access(readyPath).then(() => true, () => false)).toBe(true);
      const second = await runProcess(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], repositoryRoot, {
        ...baseEnvironment, DAI_TEST_STATE: charterStatePath, DAI_TEST_PAUSE: "0",
      });
      const secondOutcome = JSON.parse(second.stdout) as { kind: string; message?: string };
      expect(second.exitCode).toBe(0);
      expect(secondOutcome).toMatchObject({ kind: "blocked", message: "Another durable task is being admitted at this root" });
      await writeFile(releasePath, "release", "utf8");
      const first = await firstPromise;
      const firstOutcome = JSON.parse(first.stdout) as { kind: string; taskId: string | null };
      expect(first.exitCode).toBe(0);
      expect(firstOutcome).toMatchObject({ kind: "created", taskId: ordinary.taskId });
      const retry = await runProcess(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], repositoryRoot, {
        ...baseEnvironment, DAI_TEST_STATE: charterStatePath, DAI_TEST_PAUSE: "0",
      });
      const retryOutcome = JSON.parse(retry.stdout) as { kind: string; message?: string };
      expect(retry.exitCode).toBe(0);
      expect(retryOutcome).toMatchObject({ kind: "blocked", message: "A different approved charter already owns this project" });
      const durableStore = new FileDurableContextStore(durableRoot);
      expect((await durableStore.load(ordinary.taskId))?.taskCharter).toBeUndefined();
      expect(await durableStore.load(charterState.taskId)).toBeNull();
      expect(await durableStore.hasProjectSuccessorConflict(projectIdentity)).toBe(false);
      expect((await readdir(durableRoot)).filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry))).toEqual([ordinary.taskId]);
    } finally {
      await writeFile(releasePath, "release", "utf8").catch(() => undefined);
      await firstPromise?.catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 60_000);

  it("keeps public CLI ordinary-establish and approved-charter races to one durable task", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-charter-public-race-"));
    const workspacePath = join(root, "workspace");
    const appDataPath = join(root, "isolated-appdata");
    const charterPath = join(root, "approved-charter.json");
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const cliPath = join(repositoryRoot, "src", "entry", "codex-cli.ts");
    try {
      await mkdir(workspacePath, { recursive: true });
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await runGit(workspacePath, "init", "--initial-branch=main");
      await runGit(workspacePath, "config", "user.name", "Synthetic Integration");
      await runGit(workspacePath, "config", "user.email", "synthetic@example.invalid");
      await writeFile(join(workspacePath, "README.md"), "synthetic public race\n", "utf8");
      await writeFile(join(workspacePath, ".gitignore"), ".d-ai/\n", "utf8");
      await runGit(workspacePath, "add", "README.md", ".gitignore");
      await runGit(workspacePath, "commit", "-m", "synthetic public race");
      await runGit(workspacePath, "remote", "add", "origin", "https://github.com/example/public-race-fixture.git");
      const canonicalWorkspacePath = await realpath(workspacePath);
      const projectIdentity = "remote-repository:github.com/example/public-race-fixture";
      const approvedCharter = charter(projectIdentity);
      const digest = taskCharterContentDigest(approvedCharter);
      await writeFile(charterPath, JSON.stringify(approvedCharter), "utf8");
      const isolatedEnvironment = {
        ...process.env,
        D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(root, "synthetic-gitconfig"),
        GIT_TERMINAL_PROMPT: "0",
        ...(process.platform === "win32" ? { LOCALAPPDATA: appDataPath } : { XDG_DATA_HOME: appDataPath }),
      };
      const ordinary = runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath, "--command", "@D-AI establish ordinary public race",
      ], repositoryRoot, isolatedEnvironment);
      const approved = runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath,
        "--command", "@D-AI establish approved public race",
        "--task-charter-file", charterPath,
        "--approve-task-charter", digest,
      ], repositoryRoot, isolatedEnvironment);
      const [ordinaryResult, approvedResult] = await Promise.all([ordinary, approved]);
      const outcomes = [
        parseCLIResult(ordinaryResult.exitCode, ordinaryResult.stdout, ordinaryResult.stderr),
        parseCLIResult(approvedResult.exitCode, approvedResult.stdout, approvedResult.stderr),
      ];
      const [ordinaryOutcome, approvedOutcome] = outcomes;
      const ordinaryCapabilityBlockMessage = "No safe bounded Codex verification operation is configured for this intent";
      expect(outcomes.every((outcome) => outcome.response.status === "accepted" || outcome.response.status === "blocked")).toBe(true);
      expect(outcomes.every((outcome) => outcome.exitCode === (outcome.response.status === "accepted" ? 0 : 2))).toBe(true);
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.response.status !== "blocked") continue;
        if (index === 0 && outcome.response.message === ordinaryCapabilityBlockMessage) continue;
        expect(outcome.response.message).toMatch(/conflict|competing|history|in progress|admission/iu);
      }
      const rootEntries = await readdir(join(workspacePath, ".d-ai"));
      const taskIds = rootEntries.filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry));
      expect(taskIds.length).toBeLessThanOrEqual(1);
      const store = new FileDurableContextStore(join(workspacePath, ".d-ai"));
      let durableTask: TaskState | null = null;
      if (taskIds.length === 1) {
        durableTask = await store.load(taskIds[0]!);
        expect(durableTask).not.toBeNull();
        expect(durableTask?.contextManifest).toContain(projectIdentity);
      }
      const activeTasks = taskIds.length === 0 ? [] : await store.discoverActiveTasks(workspacePath);
      if (durableTask !== null) {
        expect(durableTask.environment).toBe("codex");
        expect(durableTask.contextManifest).toContain(projectIdentity);
        expect(activeTasks).toHaveLength(1);
        expect(activeTasks[0]?.taskId).toBe(durableTask.taskId);
        expect(activeTasks[0]?.environment).toBe("codex");
        expect(activeTasks[0]?.contextManifest).toContain(projectIdentity);
      }
      if (ordinaryOutcome?.response.status === "accepted") {
        if (durableTask === null || typeof ordinaryOutcome.response.taskId !== "string" || ordinaryOutcome.response.taskId.length === 0) {
          throw new Error("Accepted ordinary race outcome has no persisted task ID");
        }
        expect(durableTask.taskId).toBe(ordinaryOutcome.response.taskId);
        if (durableTask?.taskCharter !== undefined) expect(ordinaryOutcome.response.message).toMatch(/reus/iu);
      }
      if (ordinaryOutcome?.response.status === "blocked" && ordinaryOutcome.response.message === ordinaryCapabilityBlockMessage) {
        if (durableTask === null || typeof ordinaryOutcome.response.taskId !== "string" || ordinaryOutcome.response.taskId.length === 0) {
          throw new Error("Capability-blocked ordinary race outcome has no persisted task ID");
        }
        expect(durableTask.taskId).toBe(ordinaryOutcome.response.taskId);
        expect(durableTask.goal).toBe("establish ordinary public race");
        expect(durableTask.stage).toBe("recover");
        expect(durableTask.environment).toBe("codex");
        expect(ordinaryOutcome.response.stage).toBe("recover");
        expect(durableTask?.taskCharter).toBeUndefined();
        const workspaceIdentityPrefix = `identity:workspace:${canonicalWorkspacePath}:`;
        const repositoryIdentityPrefix = `identity:repository:${canonicalWorkspacePath}:`;
        expect(durableTask.contextManifest.some((entry) => entry.startsWith(workspaceIdentityPrefix))).toBe(true);
        expect(durableTask.contextManifest.some((entry) => entry.startsWith(repositoryIdentityPrefix))).toBe(true);
        expect(durableTask.contextManifest).toContain(projectIdentity);
        expect(activeTasks).toHaveLength(1);
        expect(activeTasks[0]).toMatchObject({ taskId: durableTask.taskId, goal: durableTask.goal, stage: "recover", environment: "codex" });
        expect(activeTasks[0]?.contextManifest.some((entry) => entry.startsWith(workspaceIdentityPrefix))).toBe(true);
        expect(activeTasks[0]?.contextManifest.some((entry) => entry.startsWith(repositoryIdentityPrefix))).toBe(true);
        if (approvedOutcome?.response.status === "accepted") {
          expect(approvedOutcome.response.taskId).toBe(durableTask.taskId);
          expect(approvedOutcome.response.message).toBe(`Reused the existing active project task ${durableTask.taskId}; no successor was created`);
        } else if (approvedOutcome?.response.status === "blocked") {
          expect(approvedOutcome.response.message).toMatch(/conflict|competing|history|in progress|admission/iu);
        } else {
          throw new Error("Capability-blocked ordinary race had no accepted reuse or recognized approved rejection");
        }
      }
      if (approvedOutcome?.response.status === "accepted") {
        expect(durableTask?.taskId).toBe(approvedOutcome.response.taskId);
        if (durableTask?.taskCharter !== undefined) {
          expect(durableTask.taskId).toBe(taskCharterTaskId(projectIdentity, digest));
          expect(durableTask.taskCharter).toEqual(approvedCharter);
          expect(durableTask.taskCharter.approval.approvedCharterDigest).toBe(digest);
          expect(approvedOutcome.response.taskCharter).toEqual(approvedCharter);
          expect(durableTask.stage).toBe("bootstrap");
        } else {
          if (durableTask === null || ordinaryOutcome === undefined) throw new Error("Approved reuse has no persisted ordinary race task");
          expect(approvedOutcome.response.message).toBe(`Reused the existing active project task ${durableTask.taskId}; no successor was created`);
          expect(ordinaryOutcome.response.taskId).toBe(durableTask.taskId);
          expect(durableTask.goal).toBe("establish ordinary public race");
          expect(durableTask.stage).toBe("recover");
          expect(durableTask.environment).toBe("codex");
          expect(durableTask.taskCharter).toBeUndefined();
          const workspaceIdentityPrefix = `identity:workspace:${canonicalWorkspacePath}:`;
          const repositoryIdentityPrefix = `identity:repository:${canonicalWorkspacePath}:`;
          expect(durableTask.contextManifest.some((entry) => entry.startsWith(workspaceIdentityPrefix))).toBe(true);
          expect(durableTask.contextManifest.some((entry) => entry.startsWith(repositoryIdentityPrefix))).toBe(true);
          expect(durableTask.contextManifest).toContain(projectIdentity);
          expect(activeTasks).toHaveLength(1);
          expect(activeTasks[0]).toMatchObject({
            taskId: durableTask.taskId,
            goal: durableTask.goal,
            stage: "recover",
            environment: "codex",
          });
          expect(activeTasks[0]?.contextManifest.some((entry) => entry.startsWith(workspaceIdentityPrefix))).toBe(true);
          expect(activeTasks[0]?.contextManifest.some((entry) => entry.startsWith(repositoryIdentityPrefix))).toBe(true);
          if (ordinaryOutcome.response.status === "accepted") {
            expect(ordinaryOutcome.response.message).toBe(`Reused the project task ${durableTask.taskId} that appeared during initial admission`);
            expect(ordinaryOutcome.response.stage).toBe("recover");
          } else {
            expect(ordinaryOutcome.response.status).toBe("blocked");
            expect(ordinaryOutcome.response.message).toBe(ordinaryCapabilityBlockMessage);
            expect(ordinaryOutcome.response.stage).toBe("recover");
            expect(ordinaryOutcome.exitCode).toBe(2);
          }
        }
      }
      const finalConflict = await store.hasProjectSuccessorConflict(projectIdentity);
      const statusResult = await runProcess(process.execPath, ["--import", "tsx", cliPath,
        "--workspace", workspacePath,
        "--command", "@D-AI status",
      ], repositoryRoot, isolatedEnvironment);
      const status = parseCLIResult(statusResult.exitCode, statusResult.stdout, statusResult.stderr);
      if (finalConflict) {
        expect(status.exitCode).toBe(2);
        expect(status.response.status).toBe("blocked");
        expect(status.response.message).toMatch(/conflict|competing|history|in progress|admission/iu);
      } else {
        expect(taskIds).toHaveLength(1);
        expect(status).toMatchObject({
          exitCode: 0,
          response: { taskId: taskIds[0], status: "accepted" },
        });
        expect(await store.discoverActiveTasks(workspacePath)).toHaveLength(1);
      }
      console.info("[rev7-public-initial-race]", JSON.stringify({
        outcomes: outcomes.map(({ exitCode, response }) => ({ exitCode, status: response.status, taskId: response.taskId, message: response.message })),
        ordinaryCapabilityRefusal: ordinaryOutcome?.response.status === "blocked" && ordinaryOutcome.response.message === ordinaryCapabilityBlockMessage
          ? { taskId: ordinaryOutcome.response.taskId, stage: ordinaryOutcome.response.stage, message: ordinaryOutcome.response.message }
          : null,
        taskIds,
        durableTask: durableTask === null ? null : {
          taskId: durableTask.taskId,
          goal: durableTask.goal,
          stage: durableTask.stage,
          environment: durableTask.environment,
          projectIdentityBound: durableTask.contextManifest.includes(projectIdentity),
          hasTaskCharter: durableTask.taskCharter !== undefined,
        },
        finalConflict,
        finalStatus: { exitCode: status.exitCode, status: status.response.status, taskId: status.response.taskId, message: status.response.message },
      }));
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }, 60_000);

  it("checks exact-baseline read, rejection, and restore outcomes against candidate writes", async () => {
    const baselineCommit = "9059fc5aff1f339b52d6265f96b9fad48f0390c6";
    const runnerAppDataVariable = process.platform === "win32" ? "LOCALAPPDATA" : "XDG_DATA_HOME";
    const originalRunnerAppData = process.env[runnerAppDataVariable];
    const expectedRunnerAppDataOverride = process.env.DAI_TEST_EXPECTED_APPDATA;
    const configuredRunnerAppData = expectedRunnerAppDataOverride === undefined ? undefined : resolve(expectedRunnerAppDataOverride);
    if (configuredRunnerAppData !== undefined
      && (originalRunnerAppData === undefined || resolve(originalRunnerAppData) !== configuredRunnerAppData)) {
      throw new Error("DAI_TEST_EXPECTED_APPDATA must match the test runner's configured appdata path");
    }
    if (configuredRunnerAppData !== undefined && !isPathWithin(tmpdir(), configuredRunnerAppData)) {
      throw new Error("DAI_TEST_EXPECTED_APPDATA must remain under the OS temp root");
    }
    const evidenceRootOverride = process.env.DAI_COMPAT_EVIDENCE_ROOT;
    const evidenceRoot = evidenceRootOverride === undefined
      ? await mkdtemp(join(tmpdir(), "d-ai-charter-compat-evidence-"))
      : resolve(evidenceRootOverride);
    if (!isPathWithin(tmpdir(), evidenceRoot)) throw new Error("DAI_COMPAT_EVIDENCE_ROOT must remain under the OS temp root");
    const runnerRoot = await mkdtemp(join(tmpdir(), "d-ai-charter-test-runner-"));
    const runnerAppData = configuredRunnerAppData ?? join(runnerRoot, "appdata");
    const root = await mkdtemp(join(tmpdir(), "d-ai-charter-compatibility-"));
    process.env[runnerAppDataVariable] = runnerAppData;
    let flushEvidenceForFinally: (() => Promise<void>) | null = null;
    try {
    const runnerMemoryPath = resolveDefaultMemoryDatabasePath(process.env);
    if (!isPathWithin(runnerAppData, runnerMemoryPath)) {
      throw new Error("Compatibility test-runner default memory database resolves outside synthetic appdata");
    }
    const runId = root.slice(root.lastIndexOf(sep) + 1);
    const artifactsRoot = join(evidenceRoot, `${runId}-snapshots`);
    const evidencePath = join(evidenceRoot, `${runId}-compatibility-results.json`);
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const baselineSourceRoot = join(root, "baseline-source");
    const baselineArchive = join(root, "baseline-source.tar");
    const calls: Array<Record<string, unknown>> = [];
    const snapshots: Array<Record<string, unknown>> = [];
    const evidence: Record<string, unknown> = {
      baselineCommit,
      candidateCommit: null,
      candidateFileSha256: {},
      runtimeVersion: process.version,
      baselineSourceRoot,
      baselineArchiveSha256: null,
      baselineObjectSource: null,
      baselineTree: null,
      packageLockUnchanged: false,
      manualOverridesProvided: {
        evidenceRoot: evidenceRootOverride !== undefined,
        runnerAppData: configuredRunnerAppData !== undefined,
      },
      dependencyLinkTarget: resolve(repositoryRoot, "node_modules"),
      runnerAppData: resolve(runnerAppData),
      runnerDefaultMemoryPath: runnerMemoryPath,
      calls,
      snapshots,
      scenarios: {},
    };
    const flushEvidence = async (): Promise<void> => {
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    };
    flushEvidenceForFinally = flushEvidence;
    const recordSnapshot = async (label: string, path: string): Promise<readonly (readonly [string, Buffer])[]> => {
      const snapshot = await snapshotFiles(path);
      snapshots.push({ label, path, files: summarizeSnapshot(snapshot) });
      await flushEvidence();
      return snapshot;
    };
    const invoke = async (label: string, arguments_: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      const result = await runProcess(process.execPath, arguments_, cwd, env);
      calls.push({ label, arguments: arguments_, cwd, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr });
      await flushEvidence();
      return result;
    };
    const parseOutput = (result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }): {
      readonly exitCode: number;
      readonly response: { readonly taskId?: string; readonly status?: string; readonly stage?: string; readonly environment?: string; readonly message?: string };
    } => {
      const output = result.stdout.trim().length > 0 ? result.stdout : result.stderr;
      let response: { readonly taskId?: string; readonly status?: string; readonly stage?: string; readonly environment?: string; readonly message?: string };
      try { response = JSON.parse(output) as typeof response; }
      catch { throw new Error(`Compatibility CLI returned non-JSON output (${result.exitCode}): ${result.stderr}\n${result.stdout}`); }
      return { exitCode: result.exitCode, response };
    };
    const isolatedEnvironment = (appDataPath: string): NodeJS.ProcessEnv => ({
      ...process.env,
      D_AI_GITHUB_EXTERNAL_CREDENTIALS_CONFIGURED: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(root, "synthetic-gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      ...(process.platform === "win32" ? { LOCALAPPDATA: appDataPath } : { XDG_DATA_HOME: appDataPath }),
    });
    const createRepository = async (workspacePath: string, remoteUrl: string): Promise<void> => {
      await mkdir(workspacePath, { recursive: true });
      await runGit(workspacePath, "init", "--initial-branch=main");
      await runGit(workspacePath, "config", "user.name", "Synthetic Compatibility Operator");
      await runGit(workspacePath, "config", "user.email", "synthetic@example.invalid");
      await writeFile(join(workspacePath, "README.md"), "synthetic compatibility fixture\n", "utf8");
      await writeFile(join(workspacePath, ".gitignore"), ".d-ai/\n.agents/skills/\n", "utf8");
      await runGit(workspacePath, "add", "README.md", ".gitignore");
      await runGit(workspacePath, "commit", "-m", "synthetic compatibility fixture");
      await runGit(workspacePath, "remote", "add", "origin", remoteUrl);
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
    };
    const writeCharterFile = async (workspacePath: string, project: string): Promise<{ readonly path: string; readonly value: TaskCharter; readonly digest: string }> => {
      const value = charter(project);
      const digest = taskCharterContentDigest(value);
      const path = join(workspacePath, "approved-charter.json");
      await writeFile(path, JSON.stringify(value), "utf8");
      return { path, value, digest };
    };
    const verifyCliAndAppdata = (result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }, label: string, appDataPath: string) => {
      const actual = parseOutput(result);
      expect(isPathWithin(appDataPath, resolveDefaultMemoryDatabasePath(isolatedEnvironment(appDataPath))), `${label} default memory path`).toBe(true);
      return actual;
    };
    const oldStoreModule = pathToFileURL(join(baselineSourceRoot, "src", "state", "file-durable-context-store.ts")).href;
    const oldStoreProbe = async (
      label: string,
      durableRoot: string,
      taskId: string,
      projectIdentity: string,
      operation: "inspect" | "freeze" | "read-ledger",
      env: NodeJS.ProcessEnv,
    ) => {
      const childScript = `
        import { readdir } from "node:fs/promises";
        import { join } from "node:path";
        const { FileDurableContextStore } = await import(${JSON.stringify(oldStoreModule)});
        const { DAI_COMPAT_DURABLE_ROOT: rootPath, DAI_COMPAT_TASK_ID: taskId, DAI_COMPAT_PROJECT: project, DAI_COMPAT_OPERATION: operation } = process.env;
        try {
          const store = new FileDurableContextStore(rootPath);
          let state = await store.load(taskId);
          if (state === null) throw new Error("old store could not load the expected task");
          if (operation === "freeze") {
            await store.withTaskOwnership(taskId, state.environment, async (lease) => {
              await store.save({ ...state, routingDisposition: "LEGACY_FROZEN", durableContext: null }, lease);
            });
            state = await store.load(taskId);
            if (state === null) throw new Error("old store could not reload the frozen task");
          }
          if (operation === "read-ledger") {
            try {
              const conflict = await store.hasProjectSuccessorConflict(project);
              process.stdout.write(JSON.stringify({ kind: "returned", taskId: state.taskId, conflict }));
            } catch (error) {
              process.stdout.write(JSON.stringify({ kind: "rejected", taskId: state.taskId, errorName: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error) }));
            }
          } else {
            const entries = await readdir(join(rootPath, taskId, "generations"), { withFileTypes: true });
            const generationIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
            const manifests = await Promise.all(generationIds.map((id) => store.loadGenerationManifest(taskId, id)));
            const conflict = await store.hasProjectSuccessorConflict(project);
            process.stdout.write(JSON.stringify({
              kind: operation,
              taskId: state.taskId,
              stage: state.stage,
              routingDisposition: state.routingDisposition ?? null,
              manifestId: state.durableContext?.manifestId ?? null,
              taskCharter: state.taskCharter ?? null,
              generationIds,
              generationManifestIds: manifests.map((entry) => entry.manifestId),
              conflict,
            }));
          }
        } catch (error) {
          process.stdout.write(JSON.stringify({ kind: "error", errorName: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : String(error) }));
        }
      `;
      return invoke(label, ["--import", "tsx", "--input-type=module", "--eval", childScript], baselineSourceRoot, {
        ...env,
        DAI_COMPAT_DURABLE_ROOT: durableRoot,
        DAI_COMPAT_TASK_ID: taskId,
        DAI_COMPAT_PROJECT: projectIdentity,
        DAI_COMPAT_OPERATION: operation,
      });
    };
      if (!isPathWithin(tmpdir(), root) || !isPathWithin(tmpdir(), evidenceRoot) || !isPathWithin(tmpdir(), runnerRoot)) throw new Error("Compatibility fixtures, runner appdata, and evidence must remain under the OS temp root");
      await mkdir(artifactsRoot, { recursive: true });
      evidence.candidateCommit = await gitOutput(repositoryRoot, "rev-parse", "HEAD");
      const candidateHashes: Record<string, string> = {};
      for (const path of [
        "src/runtime/d-ai-runtime.ts",
        "src/state/durable-context-store.ts",
        "src/state/file-durable-context-store.ts",
        "tests/integration/task-charter-initial-registration.test.ts",
        "tests/state/file-durable-context-store.test.ts",
      ]) {
        candidateHashes[path] = createHash("sha256").update(await readFile(join(repositoryRoot, path))).digest("hex");
      }
      evidence.candidateFileSha256 = candidateHashes;

      const fixtureEnvironment = isolatedEnvironment(join(root, "fixture-appdata"));
      const localBaselineObject = await runProcess("git", ["-C", repositoryRoot, "cat-file", "-e", `${baselineCommit}^{commit}`], repositoryRoot, fixtureEnvironment);
      expect(
        localBaselineObject.exitCode === 0
          || (localBaselineObject.exitCode === 128
            && localBaselineObject.stderr.toLowerCase().includes("not a valid object name")
            && localBaselineObject.stderr.includes(baselineCommit)),
        `Baseline object lookup failed for an unexpected reason: ${localBaselineObject.stderr}`,
      ).toBe(true);
      let baselineGitDirectory: string | null = null;
      if (localBaselineObject.exitCode === 0) {
        evidence.baselineObjectSource = "existing-checkout-object";
        evidence.baselineTree = (await gitOutput(repositoryRoot, "rev-parse", `${baselineCommit}^{tree}`)).trim();
      } else {
        baselineGitDirectory = join(root, "baseline-objects.git");
        const initializeObjects = await runProcess("git", ["init", "--bare", baselineGitDirectory], root, fixtureEnvironment);
        expect(initializeObjects.exitCode, initializeObjects.stderr).toBe(0);
        const fetchBaseline = await runProcess("git", ["--git-dir", baselineGitDirectory, "fetch", "--no-tags", "--depth=1", "https://github.com/keida/D-AI-Hub.git", baselineCommit], root, fixtureEnvironment);
        expect(fetchBaseline.exitCode, `Exact approved baseline fetch failed: ${fetchBaseline.stderr}`).toBe(0);
        const fetchedCommit = await runProcess("git", ["--git-dir", baselineGitDirectory, "cat-file", "-e", `${baselineCommit}^{commit}`], root, fixtureEnvironment);
        expect(fetchedCommit.exitCode, fetchedCommit.stderr).toBe(0);
        const fetchedRefs = await runProcess("git", ["--git-dir", baselineGitDirectory, "for-each-ref", "--format=%(refname)"], root, fixtureEnvironment);
        expect(fetchedRefs.exitCode, fetchedRefs.stderr).toBe(0);
        expect(fetchedRefs.stdout.trim()).toBe("");
        const fetchedTree = await runProcess("git", ["--git-dir", baselineGitDirectory, "rev-parse", `${baselineCommit}^{tree}`], root, fixtureEnvironment);
        expect(fetchedTree.exitCode, fetchedTree.stderr).toBe(0);
        evidence.baselineObjectSource = "exact-sha-public-read-into-temporary-bare-object-repository";
        evidence.baselineTree = fetchedTree.stdout.trim();
      }
      const archiveArguments = baselineGitDirectory === null
        ? ["-C", repositoryRoot, "archive", "--format=tar", "--output", baselineArchive, baselineCommit]
        : ["--git-dir", baselineGitDirectory, "archive", "--format=tar", "--output", baselineArchive, baselineCommit];
      const archiveResult = await runProcess("git", archiveArguments, repositoryRoot, fixtureEnvironment);
      expect(archiveResult.exitCode, archiveResult.stderr).toBe(0);
      await mkdir(baselineSourceRoot, { recursive: true });
      const extractResult = await runProcess("tar", ["-xf", baselineArchive, "-C", baselineSourceRoot], repositoryRoot, fixtureEnvironment);
      expect(extractResult.exitCode, extractResult.stderr).toBe(0);
      await symlink(join(repositoryRoot, "node_modules"), join(baselineSourceRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      const oldPackageLock = JSON.parse(await readFile(join(baselineSourceRoot, "package-lock.json"), "utf8")) as unknown;
      const candidatePackageLock = JSON.parse(await readFile(join(repositoryRoot, "package-lock.json"), "utf8")) as unknown;
      expect(oldPackageLock).toEqual(candidatePackageLock);
      evidence.packageLockUnchanged = true;
      evidence.baselineArchiveSha256 = createHash("sha256").update(await readFile(baselineArchive)).digest("hex");
      await cp(baselineArchive, join(artifactsRoot, "exact-baseline-source.tar"));

      const oldCliPath = join(baselineSourceRoot, "src", "entry", "codex-cli.ts");
      const newCliPath = join(repositoryRoot, "src", "entry", "codex-cli.ts");

      // A. Old public registration/history is read by the candidate, and is not mistaken for an empty root.
      const oldHistoryWorkspace = join(root, "old-history-workspace");
      const oldHistoryProject = "remote-repository:github.com/example/compat-old-history";
      const oldHistoryRoot = join(oldHistoryWorkspace, ".d-ai");
      const oldHistoryAppData = join(root, "old-history-appdata");
      const oldHistoryEnv = isolatedEnvironment(oldHistoryAppData);
      await createRepository(oldHistoryWorkspace, "https://github.com/example/compat-old-history.git");
      const oldCreate = await invoke("A.old-public-establish", ["--import", "tsx", oldCliPath,
        "--workspace", oldHistoryWorkspace, "--command", "@D-AI establish old compatibility history",
      ], baselineSourceRoot, oldHistoryEnv);
      const oldCreateResult = verifyCliAndAppdata(oldCreate, "A.old-public-establish", oldHistoryAppData);
      expect(oldCreateResult).toMatchObject({
        exitCode: 2,
        response: { status: "blocked", message: expect.stringContaining("No safe bounded Codex verification operation") },
      });
      const oldTaskId = oldCreateResult.response.taskId;
      expect(oldTaskId).toMatch(/^task-[a-f0-9]{24}$/u);
      const oldHistorySnapshot = await recordSnapshot("A.old-registration-history", oldHistoryRoot);
      const candidateStore = new FileDurableContextStore(oldHistoryRoot);
      const recoveredOld = await candidateStore.load(oldTaskId!);
      expect(recoveredOld?.durableContext).not.toBeNull();
      expect(recoveredOld?.contextManifest).toContain(oldHistoryProject);
      const oldGenerationIds = (await readdir(join(oldHistoryRoot, oldTaskId!, "generations"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
      expect(oldGenerationIds.length).toBeGreaterThan(0);
      for (const generationId of oldGenerationIds) {
        const generationManifest = await candidateStore.loadGenerationManifest!(oldTaskId!, generationId);
        expect(generationManifest.manifestId).toBe(generationId);
        expect(generationManifest.durablePaths).toContain(join(oldHistoryRoot, oldTaskId!, "state.json"));
      }
      const newHistoryStatus = await invoke("A.new-public-status", ["--import", "tsx", newCliPath,
        "--workspace", oldHistoryWorkspace, "--command", "@D-AI status",
      ], repositoryRoot, oldHistoryEnv);
      const newHistoryStatusResult = verifyCliAndAppdata(newHistoryStatus, "A.new-public-status", oldHistoryAppData);
      expect(newHistoryStatusResult).toMatchObject({ exitCode: 0, response: { taskId: oldTaskId, status: "accepted" } });
      const beforeInitialCharterAttempt = await snapshotFiles(oldHistoryRoot);
      const oldHistoryCharter = await writeCharterFile(oldHistoryWorkspace, oldHistoryProject);
      const candidateInitialAttempt = await invoke("A.new-approved-charter-on-old-history", ["--import", "tsx", newCliPath,
        "--workspace", oldHistoryWorkspace, "--command", "@D-AI establish must-not-reclassify-old-history",
        "--task-charter-file", oldHistoryCharter.path, "--approve-task-charter", oldHistoryCharter.digest,
      ], repositoryRoot, oldHistoryEnv);
      const candidateInitialResult = verifyCliAndAppdata(candidateInitialAttempt, "A.new-approved-charter-on-old-history", oldHistoryAppData);
      expect(candidateInitialResult).toMatchObject({
        exitCode: 0,
        response: {
          taskId: oldTaskId,
          status: "accepted",
          message: expect.stringMatching(/Reused the existing active project task .*no successor was created/iu),
        },
      });
      expect(await snapshotFiles(oldHistoryRoot)).toEqual(beforeInitialCharterAttempt);
      expect(await candidateStore.load(oldTaskId!)).not.toBeNull();
      expect(recoveredOld?.taskCharter).toBeUndefined();
      (evidence.scenarios as Record<string, unknown>).A = {
        projectIdentity: oldHistoryProject,
        oldTaskId,
        oldTaskStateRecoveredByCandidate: recoveredOld,
        oldGenerationIdsReadByCandidate: oldGenerationIds,
        publicNewStatus: newHistoryStatusResult,
        initialCharterAttempt: candidateInitialResult,
        durableRootUnchangedAfterBlockedAttempt: true,
      };
      await flushEvidence();

      // B. Candidate-approved initial charter remains loadable and usable through the exact old source.
      const newApprovedWorkspace = join(root, "new-approved-workspace");
      const newApprovedProject = "remote-repository:github.com/example/compat-new-approved";
      const newApprovedRoot = join(newApprovedWorkspace, ".d-ai");
      const newApprovedAppData = join(root, "new-approved-appdata");
      const newApprovedEnv = isolatedEnvironment(newApprovedAppData);
      await createRepository(newApprovedWorkspace, "https://github.com/example/compat-new-approved.git");
      const newApprovedCharter = await writeCharterFile(newApprovedWorkspace, newApprovedProject);
      const newCreate = await invoke("B.new-public-approved-initial", ["--import", "tsx", newCliPath,
        "--workspace", newApprovedWorkspace, "--command", "@D-AI establish new approved compatibility task",
        "--task-charter-file", newApprovedCharter.path, "--approve-task-charter", newApprovedCharter.digest,
      ], repositoryRoot, newApprovedEnv);
      const newCreateResult = verifyCliAndAppdata(newCreate, "B.new-public-approved-initial", newApprovedAppData);
      expect(newCreateResult).toMatchObject({
        exitCode: 0,
        response: { taskId: taskCharterTaskId(newApprovedProject, newApprovedCharter.digest), status: "accepted" },
      });
      const newApprovedTaskId = newCreateResult.response.taskId!;
      const oldApprovedStore = await oldStoreProbe("B.old-store-load-and-generation-read", newApprovedRoot, newApprovedTaskId, newApprovedProject, "inspect", newApprovedEnv);
      const oldApprovedStoreResult = JSON.parse(oldApprovedStore.stdout) as { kind: string; taskId?: string; taskCharter?: TaskCharter | null; generationIds?: string[]; generationManifestIds?: string[]; conflict?: boolean };
      expect(oldApprovedStoreResult).toMatchObject({
        kind: "inspect",
        taskId: newApprovedTaskId,
        taskCharter: newApprovedCharter.value,
        conflict: false,
      });
      expect(oldApprovedStoreResult.generationIds).toEqual(oldApprovedStoreResult.generationManifestIds);
      const oldApprovedStatus = await invoke("B.old-public-normal-status", ["--import", "tsx", oldCliPath,
        "--workspace", newApprovedWorkspace, "--command", "@D-AI status",
      ], baselineSourceRoot, newApprovedEnv);
      const oldApprovedStatusResult = verifyCliAndAppdata(oldApprovedStatus, "B.old-public-normal-status", newApprovedAppData);
      expect(oldApprovedStatusResult).toMatchObject({ exitCode: 0, response: { taskId: newApprovedTaskId, status: "accepted" } });
      const oldApprovedNormalContinue = await invoke("B.old-public-normal-continue", ["--import", "tsx", oldCliPath,
        "--workspace", newApprovedWorkspace, "--command", "@D-AI continue",
      ], baselineSourceRoot, newApprovedEnv);
      const oldApprovedNormalContinueResult = verifyCliAndAppdata(oldApprovedNormalContinue, "B.old-public-normal-continue", newApprovedAppData);
      expect(["accepted", "blocked"]).toContain(oldApprovedNormalContinueResult.response.status);
      expect(oldApprovedNormalContinueResult.response.taskId).toBe(newApprovedTaskId);
      if (oldApprovedNormalContinueResult.response.status === "blocked") {
        expect(oldApprovedNormalContinueResult.exitCode).toBe(2);
        expect(oldApprovedNormalContinueResult.response.message).toBe("Authoritative current-state access is blocked: Local memory database is unavailable");
      } else {
        expect(oldApprovedNormalContinueResult.exitCode).toBe(0);
      }
      const oldApprovedContinue = await invoke("B.old-public-continue", ["--import", "tsx", oldCliPath,
        "--workspace", newApprovedWorkspace, "--command", `@D-AI continue ${newApprovedTaskId}`,
      ], baselineSourceRoot, newApprovedEnv);
      const oldApprovedContinueResult = verifyCliAndAppdata(oldApprovedContinue, "B.old-public-continue", newApprovedAppData);
      expect(["accepted", "blocked"]).toContain(oldApprovedContinueResult.response.status);
      expect(oldApprovedContinueResult.response.taskId).toBe(newApprovedTaskId);
      if (oldApprovedContinueResult.response.status === "blocked") {
        expect(oldApprovedContinueResult.response.message).toMatch(/capabilit|configured|skill|conflict|ownership|legacy/iu);
      }
      const approvedTaskAfterOldContinue = await new FileDurableContextStore(newApprovedRoot).load(newApprovedTaskId);
      expect(approvedTaskAfterOldContinue?.taskCharter).toEqual(newApprovedCharter.value);
      (evidence.scenarios as Record<string, unknown>).B = {
        projectIdentity: newApprovedProject,
        taskId: newApprovedTaskId,
        newPublicCreate: newCreateResult,
        oldStoreLoadAndGenerationRead: oldApprovedStoreResult,
        oldPublicStatus: oldApprovedStatusResult,
        oldPublicNormalContinue: oldApprovedNormalContinueResult,
        oldPublicContinue: oldApprovedContinueResult,
        charterRetained: approvedTaskAfterOldContinue?.taskCharter ?? null,
      };
      await flushEvidence();

      // C. The old strict reader rejects only the new ordinary contender record; state remains unchanged.
      const ordinaryWorkspace = join(root, "new-ordinary-workspace");
      const ordinaryProject = "remote-repository:github.com/example/compat-new-ordinary";
      const ordinaryRoot = join(ordinaryWorkspace, ".d-ai");
      const ordinaryAppData = join(root, "new-ordinary-appdata");
      const ordinaryEnv = isolatedEnvironment(ordinaryAppData);
      await createRepository(ordinaryWorkspace, "https://github.com/example/compat-new-ordinary.git");
      const newOrdinary = await invoke("C.new-public-ordinary-establish", ["--import", "tsx", newCliPath,
        "--workspace", ordinaryWorkspace, "--command", "@D-AI establish ordinary compatibility task",
      ], repositoryRoot, ordinaryEnv);
      const newOrdinaryResult = verifyCliAndAppdata(newOrdinary, "C.new-public-ordinary-establish", ordinaryAppData);
      expect(newOrdinaryResult).toMatchObject({
        exitCode: 2,
        response: { status: "blocked", message: expect.stringContaining("No safe bounded Codex verification operation") },
      });
      const ordinaryTaskId = newOrdinaryResult.response.taskId!;
      const ordinaryBefore = await recordSnapshot("C.candidate-ordinary-before-old-reads", ordinaryRoot);
      expect(ordinaryBefore.some(([path]) => path.includes(".project-successor-election") && path.endsWith(".json"))).toBe(true);
      expect(await new FileDurableContextStore(ordinaryRoot).load(ordinaryTaskId)).toMatchObject({
        taskId: ordinaryTaskId,
        contextManifest: expect.arrayContaining([ordinaryProject]),
      });
      const oldOrdinaryLoad = await oldStoreProbe("C.old-store-load-and-ledger-rejection", ordinaryRoot, ordinaryTaskId, ordinaryProject, "read-ledger", ordinaryEnv);
      const oldOrdinaryResult = JSON.parse(oldOrdinaryLoad.stdout) as { kind: string; taskId?: string; errorName?: string; message?: string; conflict?: boolean };
      expect(oldOrdinaryResult.kind).toBe("rejected");
      expect(oldOrdinaryResult.taskId).toBe(ordinaryTaskId);
      expect(oldOrdinaryResult.message).toMatch(/candidateKind|unrecognized|unknown|invalid/iu);
      const afterOldLedgerRead = await recordSnapshot("C.after-old-store-ledger-read", ordinaryRoot);
      expect(withoutOwnershipMetadata(afterOldLedgerRead)).toEqual(withoutOwnershipMetadata(ordinaryBefore));
      const oldOrdinaryStatus = await invoke("C.old-public-normal-status", ["--import", "tsx", oldCliPath,
        "--workspace", ordinaryWorkspace, "--command", "@D-AI status",
      ], baselineSourceRoot, ordinaryEnv);
      const oldOrdinaryStatusResult = verifyCliAndAppdata(oldOrdinaryStatus, "C.old-public-normal-status", ordinaryAppData);
      const afterOldStatus = await recordSnapshot("C.after-old-public-normal-status", ordinaryRoot);
      expect(withoutOwnershipMetadata(afterOldStatus)).toEqual(withoutOwnershipMetadata(ordinaryBefore));
      if (oldOrdinaryStatusResult.response.status === "accepted") {
        expect(oldOrdinaryStatusResult.response.taskId).toBe(ordinaryTaskId);
      } else {
        expect(oldOrdinaryStatusResult.response.status).toBe("blocked");
        expect(oldOrdinaryStatusResult.response.message).toMatch(/conflict|contender|history|invalid|unknown|schema/iu);
      }
      const oldOrdinaryContinue = await invoke("C.old-public-continue", ["--import", "tsx", oldCliPath,
        "--workspace", ordinaryWorkspace, "--command", `@D-AI continue ${ordinaryTaskId}`,
      ], baselineSourceRoot, ordinaryEnv);
      const oldOrdinaryContinueResult = verifyCliAndAppdata(oldOrdinaryContinue, "C.old-public-continue", ordinaryAppData);
      const afterOldContinue = await recordSnapshot("C.after-old-public-continue", ordinaryRoot);
      expect(withoutOwnershipMetadata(afterOldContinue)).toEqual(withoutOwnershipMetadata(ordinaryBefore));
      expect(oldOrdinaryContinueResult.exitCode).toBe(2);
      expect(oldOrdinaryContinueResult.response.status).toBe("blocked");
      expect(oldOrdinaryContinueResult.response.message).toMatch(/conflict|contender|history|invalid|unknown|schema/iu);
      const ownershipRoot = join(ordinaryRoot, ordinaryTaskId, "ownership");
      const ownershipGenerations = (await readdir(ownershipRoot)).filter((entry) => /^[1-9][0-9]*$/u.test(entry)).sort((left, right) => Number(left) - Number(right));
      const ownershipRecords = await Promise.all(ownershipGenerations.map(async (generation) => {
        const generationRoot = join(ownershipRoot, generation);
        const owner = JSON.parse(await readFile(join(generationRoot, "owner.json"), "utf8")) as { taskId?: string; environment?: string; ownerToken?: string };
        const leaseToken = await readFile(join(generationRoot, "lease"), "utf8");
        const releasedToken = existsSync(join(generationRoot, "released")) ? await readFile(join(generationRoot, "released"), "utf8") : null;
        expect(owner).toMatchObject({ taskId: ordinaryTaskId, environment: "codex" });
        expect(owner.ownerToken).toBe(leaseToken);
        if (releasedToken !== null) expect(releasedToken).toBe(owner.ownerToken);
        return { generation, taskId: owner.taskId, environment: owner.environment, released: releasedToken !== null, tokenMatches: owner.ownerToken === leaseToken && (releasedToken === null || releasedToken === owner.ownerToken) };
      }));
      expect((await readdir(ordinaryRoot)).filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry))).toEqual([ordinaryTaskId]);
      (evidence.scenarios as Record<string, unknown>).C = {
        projectIdentity: ordinaryProject,
        taskId: ordinaryTaskId,
        newPublicCreate: newOrdinaryResult,
        oldStoreLedgerRead: oldOrdinaryResult,
        oldPublicNormalStatus: oldOrdinaryStatusResult,
        oldPublicContinue: oldOrdinaryContinueResult,
        logicalDurableStateUnchangedAfterEachOldRead: true,
        ownershipMetadataChanges: {
          afterOldLedgerRead: changedOwnershipFiles(ordinaryBefore, afterOldLedgerRead),
          afterOldPublicStatus: changedOwnershipFiles(afterOldLedgerRead, afterOldStatus),
          afterOldPublicContinue: changedOwnershipFiles(afterOldStatus, afterOldContinue),
          validatedGenerations: ownershipRecords,
        },
      };
      await flushEvidence();

      // D. Restore a complete OLD synthetic backup after a candidate write at the original path.
      const rollbackWorkspace = join(root, "rollback-workspace");
      const rollbackProject = "remote-repository:github.com/example/compat-rollback";
      const rollbackRoot = join(rollbackWorkspace, ".d-ai");
      const rollbackAppData = join(root, "rollback-appdata");
      const rollbackEnv = isolatedEnvironment(rollbackAppData);
      await createRepository(rollbackWorkspace, "https://github.com/example/compat-rollback.git");
      const oldRollbackCreate = await invoke("D.old-public-establish-baseline", ["--import", "tsx", oldCliPath,
        "--workspace", rollbackWorkspace, "--command", "@D-AI establish rollback baseline task",
      ], baselineSourceRoot, rollbackEnv);
      const oldRollbackCreateResult = verifyCliAndAppdata(oldRollbackCreate, "D.old-public-establish-baseline", rollbackAppData);
      expect(oldRollbackCreateResult).toMatchObject({
        exitCode: 2,
        response: { status: "blocked", message: expect.stringContaining("No safe bounded Codex verification operation") },
      });
      const rollbackTaskId = oldRollbackCreateResult.response.taskId!;
      const freezeResult = await oldStoreProbe("D.old-store-freezes-synthetic-baseline", rollbackRoot, rollbackTaskId, rollbackProject, "freeze", rollbackEnv);
      const frozenBaseline = JSON.parse(freezeResult.stdout) as { kind: string; taskId?: string; stage?: string; routingDisposition?: string; manifestId?: string; generationIds?: string[]; generationManifestIds?: string[]; conflict?: boolean };
      expect(frozenBaseline).toMatchObject({ kind: "freeze", taskId: rollbackTaskId, routingDisposition: "LEGACY_FROZEN", conflict: false });
      expect(frozenBaseline.generationIds).toEqual(frozenBaseline.generationManifestIds);
      const oldStatusBefore = await invoke("D.old-public-status-before-candidate-write", ["--import", "tsx", oldCliPath,
        "--workspace", rollbackWorkspace, "--command", "@D-AI status", "--task", rollbackTaskId,
      ], baselineSourceRoot, rollbackEnv);
      const oldStatusBeforeResult = verifyCliAndAppdata(oldStatusBefore, "D.old-public-status-before-candidate-write", rollbackAppData);
      expect(oldStatusBeforeResult).toMatchObject({ exitCode: 0, response: { taskId: rollbackTaskId, status: "accepted" } });
      const oldContinueBefore = await invoke("D.old-public-continue-before-candidate-write", ["--import", "tsx", oldCliPath,
        "--workspace", rollbackWorkspace, "--command", `@D-AI continue ${rollbackTaskId}`,
      ], baselineSourceRoot, rollbackEnv);
      const oldContinueBeforeResult = verifyCliAndAppdata(oldContinueBefore, "D.old-public-continue-before-candidate-write", rollbackAppData);
      expect(oldContinueBeforeResult).toMatchObject({ exitCode: 2, response: { taskId: rollbackTaskId, status: "blocked" } });
      expect(oldContinueBeforeResult.response.message).toMatch(/legacy-frozen|read-only/iu);
      const baselineDurableSnapshot = await recordSnapshot("D.complete-old-baseline-durable", rollbackRoot);
      const baselineActivePointers = activePointerRecords(baselineDurableSnapshot);
      expect(baselineActivePointers.length).toBeGreaterThan(0);
      const baselineAppDataSnapshot = existsSync(rollbackAppData) ? await recordSnapshot("D.old-baseline-synthetic-appdata", rollbackAppData) : [];
      const baselineBackupRoot = join(artifactsRoot, "D-old-baseline-durable-backup");
      const baselineAppDataBackup = join(artifactsRoot, "D-old-baseline-appdata-backup");
      expect(isPathWithin(root, rollbackRoot)).toBe(true);
      expect(isPathWithin(root, rollbackAppData)).toBe(true);
      await cp(rollbackRoot, baselineBackupRoot, { recursive: true, errorOnExist: true, force: false });
      const memoryBackupIncluded = existsSync(rollbackAppData);
      if (memoryBackupIncluded) await cp(rollbackAppData, baselineAppDataBackup, { recursive: true, errorOnExist: true, force: false });

      const candidateStoreRollback = new FileDurableContextStore(rollbackRoot);
      const oldDurableState = await candidateStoreRollback.load(rollbackTaskId);
      if (oldDurableState === null) throw new Error("Candidate store could not load the OLD rollback baseline");
      const baselineManifestId = oldDurableState.durableContext?.manifestId;
      await candidateStoreRollback.withTaskOwnership!(rollbackTaskId, oldDurableState.environment, async (lease) => {
        await candidateStoreRollback.save({
          ...oldDurableState,
          constraints: [...oldDurableState.constraints, "synthetic rev4 candidate forward-write"],
          durableContext: null,
        }, lease);
      });
      const candidateWrittenState = await candidateStoreRollback.load(rollbackTaskId);
      expect(candidateWrittenState?.constraints).toContain("synthetic rev4 candidate forward-write");
      expect(candidateWrittenState?.durableContext?.manifestId).not.toBe(baselineManifestId);
      if (candidateWrittenState?.durableContext === null || candidateWrittenState === null) throw new Error("Candidate forward-write did not produce a durable manifest");
      await candidateStoreRollback.loadGenerationManifest!(rollbackTaskId, candidateWrittenState.durableContext.manifestId);
      const postwriteDurableSnapshot = await recordSnapshot("D.candidate-postwrite-durable", rollbackRoot);
      const candidateActivePointers = activePointerRecords(postwriteDurableSnapshot);
      expect(candidateActivePointers.slice(0, baselineActivePointers.length)).toEqual(baselineActivePointers);
      expect(candidateActivePointers).toHaveLength(baselineActivePointers.length + 1);
      expect(candidateActivePointers.at(-1)?.value).toMatchObject({ manifestId: candidateWrittenState.durableContext.manifestId });
      const postwriteDurableCopy = join(artifactsRoot, "D-candidate-postwrite-durable-snapshot");
      await cp(rollbackRoot, postwriteDurableCopy, { recursive: true, errorOnExist: true, force: false });
      const postwriteAppDataSnapshot = existsSync(rollbackAppData) ? await recordSnapshot("D.candidate-postwrite-synthetic-appdata", rollbackAppData) : [];
      const postwriteAppDataCopy = join(artifactsRoot, "D-candidate-postwrite-appdata-snapshot");
      if (existsSync(rollbackAppData)) await cp(rollbackAppData, postwriteAppDataCopy, { recursive: true, errorOnExist: true, force: false });

      await rm(rollbackRoot, { recursive: true, force: true });
      await cp(baselineBackupRoot, rollbackRoot, { recursive: true, errorOnExist: true, force: false });
      if (memoryBackupIncluded) {
        if (existsSync(rollbackAppData)) await rm(rollbackAppData, { recursive: true, force: true });
        await cp(baselineAppDataBackup, rollbackAppData, { recursive: true, errorOnExist: true, force: false });
      } else if (existsSync(rollbackAppData)) {
        await rm(rollbackAppData, { recursive: true, force: true });
      }
      const restoredDurableSnapshot = await recordSnapshot("D.restored-old-baseline-durable", rollbackRoot);
      expect(restoredDurableSnapshot).toEqual(baselineDurableSnapshot);
      const restoredActivePointers = activePointerRecords(restoredDurableSnapshot);
      expect(restoredActivePointers).toEqual(baselineActivePointers);
      if (memoryBackupIncluded) {
        const restoredAppDataSnapshot = await recordSnapshot("D.restored-old-baseline-synthetic-appdata", rollbackAppData);
        expect(restoredAppDataSnapshot).toEqual(baselineAppDataSnapshot);
      }
      const restoredOldStore = await oldStoreProbe("D.old-store-load-after-restore", rollbackRoot, rollbackTaskId, rollbackProject, "inspect", rollbackEnv);
      const restoredOldStoreResult = JSON.parse(restoredOldStore.stdout) as { kind: string; taskId?: string; routingDisposition?: string; manifestId?: string; generationIds?: string[]; generationManifestIds?: string[]; conflict?: boolean };
      expect(restoredOldStoreResult).toMatchObject({
        kind: "inspect", taskId: rollbackTaskId, routingDisposition: "LEGACY_FROZEN", manifestId: baselineManifestId, conflict: false,
      });
      expect(restoredOldStoreResult.generationIds).toEqual(restoredOldStoreResult.generationManifestIds);
      const oldStatusAfter = await invoke("D.old-public-status-after-restore", ["--import", "tsx", oldCliPath,
        "--workspace", rollbackWorkspace, "--command", "@D-AI status", "--task", rollbackTaskId,
      ], baselineSourceRoot, rollbackEnv);
      const oldStatusAfterResult = verifyCliAndAppdata(oldStatusAfter, "D.old-public-status-after-restore", rollbackAppData);
      expect(oldStatusAfterResult).toMatchObject({ exitCode: 0, response: { taskId: rollbackTaskId, status: "accepted" } });
      expect(oldStatusAfterResult.response).toEqual(oldStatusBeforeResult.response);
      const oldContinueAfter = await invoke("D.old-public-continue-after-restore", ["--import", "tsx", oldCliPath,
        "--workspace", rollbackWorkspace, "--command", `@D-AI continue ${rollbackTaskId}`,
      ], baselineSourceRoot, rollbackEnv);
      const oldContinueAfterResult = verifyCliAndAppdata(oldContinueAfter, "D.old-public-continue-after-restore", rollbackAppData);
      expect(oldContinueAfterResult).toMatchObject({ exitCode: oldContinueBeforeResult.exitCode, response: { taskId: rollbackTaskId, status: oldContinueBeforeResult.response.status } });
      expect(oldContinueAfterResult.response).toEqual(oldContinueBeforeResult.response);
      expect(await snapshotFiles(rollbackRoot)).toEqual(restoredDurableSnapshot);
      const restoredManifest = await candidateStoreRollback.load(rollbackTaskId);
      expect(restoredManifest?.durableContext?.manifestId).toBe(baselineManifestId);
      (evidence.scenarios as Record<string, unknown>).D = {
        projectIdentity: rollbackProject,
        taskId: rollbackTaskId,
        oldBaselineStore: frozenBaseline,
        oldPublicStatusBeforeCandidateWrite: oldStatusBeforeResult,
        oldPublicContinueBeforeCandidateWrite: oldContinueBeforeResult,
        candidateWrite: { priorManifestId: baselineManifestId, writtenManifestId: candidateWrittenState.durableContext.manifestId, constraints: candidateWrittenState.constraints },
        activePointers: { baseline: baselineActivePointers, afterCandidateWrite: candidateActivePointers, afterRestore: restoredActivePointers },
        restoredOldStore: restoredOldStoreResult,
        oldPublicStatusAfterRestore: oldStatusAfterResult,
        oldPublicContinueAfterRestore: oldContinueAfterResult,
        manifestIdentityRestored: restoredManifest?.durableContext?.manifestId,
        completeDurableBackup: baselineBackupRoot,
        postwriteDurableSnapshot: postwriteDurableCopy,
        memoryBackupIncluded,
        baselineAppDataFiles: summarizeSnapshot(baselineAppDataSnapshot),
        postwriteAppDataFiles: summarizeSnapshot(postwriteAppDataSnapshot),
        continuationCompleteness: "OLD public continue is explicitly blocked for LEGACY_FROZEN history; this verifies read-only recovery, not continued project work.",
      };
      await flushEvidence();
    } finally {
      try {
        if (flushEvidenceForFinally !== null) await flushEvidenceForFinally();
      } finally {
        if (originalRunnerAppData === undefined) delete process.env[runnerAppDataVariable];
        else process.env[runnerAppDataVariable] = originalRunnerAppData;
        await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
        await rm(runnerRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
      }
    }
  }, 180_000);
});
