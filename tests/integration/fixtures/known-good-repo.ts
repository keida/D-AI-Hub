import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runCommand, type CommandRequest } from "../../../src/adapters/command-runner.js";
import { createSkillLibrary, type SkillLibraryFixture } from "./skill-library.js";

export interface KnownGoodRepositoryFixture {
  readonly rootPath: string;
  readonly repositoryPath: string;
  readonly bareRemotePath: string;
  readonly branch: string;
  readonly ref: string;
  readonly commitSha: string;
  readonly durableContextRoot: string;
  readonly handoffPersistencePath: string;
  readonly failingCommand: CommandRequest;
  readonly regressionCommand: CommandRequest;
  readonly recoveryMarkerPath: string;
  readonly skillLibrary: SkillLibraryFixture;
  readonly cleanup: () => Promise<void>;
}

async function git(cwd: string | null, argumentsList: readonly string[]): Promise<string> {
  const result = await runCommand({ command: "git", arguments: argumentsList, cwd });
  return result.stdout.trim();
}

function assertSafeCleanupTarget(rootPath: string): void {
  const resolvedRoot = resolve(rootPath);
  if (dirname(resolvedRoot) !== resolve(tmpdir()) || !resolvedRoot.startsWith(resolve(tmpdir(), "d-ai-v1-contract-"))) {
    throw new Error(`Refusing to clean an unsafe Task 10 fixture path: ${resolvedRoot}`);
  }
}

export async function createKnownGoodRepository(): Promise<KnownGoodRepositoryFixture> {
  const rootPath = await mkdtemp(join(tmpdir(), "d-ai-v1-contract-"));
  const repositoryPath = join(rootPath, "repository");
  const bareRemotePath = join(rootPath, "remote.git");
  const branch = "task-10-known-good";
  const ref = `refs/heads/${branch}`;
  const durableContextRoot = join(repositoryPath, ".d-ai", "tasks");
  const handoffPersistencePath = join(repositoryPath, ".d-ai", "handoffs.json");
  const failingScriptPath = join(repositoryPath, "commands", "fail.mjs");
  const passingScriptPath = join(repositoryPath, "commands", "pass.mjs");
  const recoveryMarkerPath = join(repositoryPath, "commands", "recoverable.marker");
  const skillRootPath = join(repositoryPath, ".agents", "skills");

  try {
    await git(null, ["init", "--bare", bareRemotePath]);
    await git(null, ["init", `--initial-branch=${branch}`, repositoryPath]);
    await git(repositoryPath, ["config", "user.email", "d-ai-contract@example.test"]);
    await git(repositoryPath, ["config", "user.name", "D-AI Contract Test"]);
    await mkdir(join(repositoryPath, "commands"), { recursive: true });
    await mkdir(durableContextRoot, { recursive: true });
    await writeFile(join(repositoryPath, ".gitignore"), ".d-ai/\n", "utf8");
    await writeFile(join(repositoryPath, "artifact.txt"), "known-good artifact\n", "utf8");
    await writeFile(failingScriptPath, "import { access } from 'node:fs/promises';\ntry { await access(new URL('./recoverable.marker', import.meta.url)); process.stderr.write('recoverable marker present\\n'); process.exit(23); } catch { process.stdout.write('fixture command recovered\\n'); }\n", "utf8");
    await writeFile(passingScriptPath, "process.stdout.write('fixture verification passed\\n');\n", "utf8");
    const skillLibrary = await createSkillLibrary(skillRootPath);
    await git(repositoryPath, ["add", "."]);
    await git(repositoryPath, ["commit", "-m", "known-good Task 10 fixture"]);
    const commitSha = await git(repositoryPath, ["rev-parse", "HEAD"]);
    await git(repositoryPath, ["remote", "add", "origin", "https://github.com/d-ai-contract/known-good.git"]);
    await writeFile(recoveryMarkerPath, "remove during recovery\n", "utf8");

    return {
      rootPath,
      repositoryPath,
      bareRemotePath,
      branch,
      ref,
      commitSha,
      durableContextRoot,
      handoffPersistencePath,
      failingCommand: { command: process.execPath, arguments: [failingScriptPath], cwd: repositoryPath },
      regressionCommand: { command: process.execPath, arguments: [passingScriptPath], cwd: repositoryPath },
      recoveryMarkerPath,
      skillLibrary,
      cleanup: async (): Promise<void> => {
        assertSafeCleanupTarget(rootPath);
        await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      },
    };
  } catch (error: unknown) {
    assertSafeCleanupTarget(rootPath);
    await rm(rootPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    throw error;
  }
}
