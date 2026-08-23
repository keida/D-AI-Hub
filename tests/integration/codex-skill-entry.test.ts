import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("D-AI Codex Skill product boundary", { timeout: 20_000 }, () => {
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

  it("returns BLOCKED when the routed Codex execution connector is unconfigured", async () => {
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
      expect(response).toMatchObject({ environment: "codex", status: "blocked", stage: "recover" });
      expect(response.message).toMatch(/No execution connector is configured for codex/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
