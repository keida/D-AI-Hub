import { spawn } from "node:child_process";
import { access, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/adapters/command-runner.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runPowerShell(scriptPath: string, workspacePath: string, commandText: string): Promise<ProcessResult> {
  return runPowerShellArguments(scriptPath, workspacePath, [
    "-WorkspacePath",
    workspacePath,
    "-CommandText",
    commandText,
  ]);
}

function runPowerShellArguments(scriptPath: string, cwdPath: string, argumentsList: readonly string[], pathPrefix?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      ...argumentsList,
    ], {
      cwd: cwdPath,
      windowsHide: true,
      ...(pathPrefix === undefined ? {} : { env: { ...process.env, PATH: `${pathPrefix};${process.env.PATH ?? ""}` } }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
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
  await runCommand({ command: "git", arguments: argumentsList, cwd: workspacePath });
}

describe.skipIf(process.platform !== "win32")("D-AI Codex Skill PowerShell product boundary", { timeout: 20_000 }, () => {
  it("uses the explicit binding from D-AI-Hub, Quote Float-like, and unrelated CWDs", async () => {
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
        const result = await runPowerShellArguments(join(installedSkillPath, "scripts", "invoke.ps1"), cwd, args);
        expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(2);
        const response = JSON.parse(result.stdout) as Record<string, unknown>;
        expect(response.message).toMatch(/No active D-AI task matches this workspace/i);
        expect(await pathExists(join(workspacePath, ".d-ai"))).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before runtime invocation for missing, stale, invalid, relative, and drive-relative bindings", async () => {
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
        const result = await runPowerShellArguments(join(installedSkillPath, "scripts", "invoke.ps1"), workspacePath, ["-WorkspacePath", workspacePath, "-CommandText", "@D-AI status"], binPath);
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

  it("creates, idempotently preserves, and updates a validated runtime binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-binding-tool-"));
    const installedSkillPath = await createInstalledSkill(root);
    const runtimeRoot = process.cwd();
    const secondRuntimeRoot = join(root, "second-runtime");
    try {
      await mkdir(join(secondRuntimeRoot, "src", "entry"), { recursive: true });
      await copyFile(join(runtimeRoot, "package.json"), join(secondRuntimeRoot, "package.json"));
      await copyFile(join(runtimeRoot, "src", "entry", "codex-cli.ts"), join(secondRuntimeRoot, "src", "entry", "codex-cli.ts"));
      const setScript = join(installedSkillPath, "scripts", "set-runtime-binding.ps1");
      const invoke = (target: string) => runPowerShellArguments(setScript, root, ["-SkillRoot", installedSkillPath, "-RuntimeRoot", target]);

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
        const result = await runPowerShellArguments(setScript, root, ["-SkillRoot", mistypedSkillRoot, "-RuntimeRoot", secondRuntimeRoot]);
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

  it("discovers the Skill and sends a raw close command into the configured runtime from an unrelated workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-e2e-"));
    const workspacePath = join(root, "unrelated-workspace");
    try {
      await mkdir(workspacePath);
      const entryPath = join(await createBoundInstalledSkill(root), "scripts", "invoke.ps1");

      const result = await runPowerShell(entryPath, workspacePath, "@D-AI close");

      expect(result.exitCode, result.stderr).toBe(2);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ taskId: "unassigned", environment: "codex", status: "blocked" });
      expect(response.message).toMatch(/No active D-AI task matches this workspace.*--task <task-id>/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns BLOCKED when the configured Codex workspace is not a Git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-connector-"));
    const workspacePath = join(root, "unrelated-workspace");
    const executionSkillPath = join(repositoryRoot, "tests", "fixtures", "skills", "typescript-execution");
    try {
      await mkdir(workspacePath);
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await symlink(executionSkillPath, join(workspacePath, ".agents", "skills", "typescript-execution"), "junction");
      const entryPath = join(await createBoundInstalledSkill(root), "scripts", "invoke.ps1");

      const result = await runPowerShell(entryPath, workspacePath, "@D-AI implement typescript");

      expect(result.exitCode, result.stderr).toBe(2);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ taskId: "unassigned", environment: "codex", status: "blocked", stage: "bootstrap" });
      expect(response.message).toMatch(/Configured Codex.*Git repository root/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("completes a bounded verify intent through the public Skill and persists a recovery point", async () => {
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
      const result = await runPowerShell(entryPath, workspacePath, "@D-AI verify local workspace");

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(0);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ environment: "codex", status: "completed", stage: "verify" });
      expect(response.message).toMatch(/verification/i);
      expect(Array.isArray(response.evidence)).toBe(true);
      expect((response.evidence as unknown[]).length).toBe(8);
      const state = await new FileDurableContextStore(join(workspacePath, ".d-ai")).load(String(response.taskId));
      expect(state).not.toBeNull();
      expect(state?.stage).toBe("verify");
      expect(state?.recoveryPoint).not.toBeNull();
      expect(state?.criticalUnsavedContext).toHaveLength(0);
      expect(state?.contextManifest).toContain("ref:refs/heads/verify/review");
      expect(state?.contextManifest).toContain("local-state:clean-required");
      expect(state?.verificationEvidence.map((item) => item.evidenceId)).toEqual(expect.arrayContaining(["gate:recovery"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks unsupported remotes at the public Skill execution boundary", async () => {
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
      const result = await runPowerShell(entryPath, workspacePath, "@D-AI verify local workspace");

      expect(result.exitCode, `${result.stderr}\n${result.stdout}`).toBe(2);
      const response = JSON.parse(result.stdout) as Record<string, unknown>;
      expect(response).toMatchObject({ taskId: "unassigned", environment: "codex", status: "blocked", stage: "bootstrap" });
      expect(response.message).toMatch(/Configured Codex.*GitHub.*identity|origin/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
