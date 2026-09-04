import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../../src/adapters/command-runner.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { describe, expect, it } from "vitest";

interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runPowerShell(scriptPath: string, workspacePath: string, commandText: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-WorkspacePath",
      workspacePath,
      "-CommandText",
      commandText,
    ], { cwd: workspacePath, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function runGit(workspacePath: string, argumentsList: readonly string[]): Promise<void> {
  await runCommand({ command: "git", arguments: argumentsList, cwd: workspacePath });
}

describe.skipIf(process.platform !== "win32")("D-AI Codex Skill PowerShell product boundary", { timeout: 20_000 }, () => {
  it("discovers the Skill and sends a raw close command into the configured runtime from an unrelated workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-codex-skill-e2e-"));
    const discoveryRoot = join(root, "user-skills");
    const workspacePath = join(root, "unrelated-workspace");
    const canonicalSkillPath = join(process.cwd(), "skills", "custom", "d-ai");
    try {
      await mkdir(discoveryRoot);
      await mkdir(workspacePath);
      await symlink(canonicalSkillPath, join(discoveryRoot, "d-ai"), "junction");
      const entryPath = join(discoveryRoot, "d-ai", "scripts", "invoke.ps1");

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
    const discoveryRoot = join(root, "user-skills");
    const workspacePath = join(root, "unrelated-workspace");
    const canonicalSkillPath = join(process.cwd(), "skills", "custom", "d-ai");
    const executionSkillPath = join(process.cwd(), "tests", "fixtures", "skills", "typescript-execution");
    try {
      await mkdir(discoveryRoot);
      await mkdir(workspacePath);
      await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
      await symlink(canonicalSkillPath, join(discoveryRoot, "d-ai"), "junction");
      await symlink(executionSkillPath, join(workspacePath, ".agents", "skills", "typescript-execution"), "junction");
      const entryPath = join(discoveryRoot, "d-ai", "scripts", "invoke.ps1");

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
    const canonicalSkillPath = join(process.cwd(), "skills", "custom", "d-ai");
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

      const entryPath = join(canonicalSkillPath, "scripts", "invoke.ps1");
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
    const canonicalSkillPath = join(process.cwd(), "skills", "custom", "d-ai");
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
      const entryPath = join(canonicalSkillPath, "scripts", "invoke.ps1");
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
