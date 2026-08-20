import { CommandExecutionError, redactSensitiveText, runCommand, type CommandResult } from "./command-runner.js";
import { CloseBlockedError, InvalidTaskStateError } from "../domain/errors.js";

export interface LocalGitState {
  readonly repositoryPath: string;
  readonly branch: string;
  readonly head: string;
  readonly worktreeStatus: string;
  readonly remote: string;
  readonly remoteUrl: string;
  readonly ref: string;
}

export interface GitPushResult {
  readonly pushed: boolean;
  readonly observedOutput: string;
  readonly exitCode: number;
}

export class GitLocalStateError extends CloseBlockedError {
  public constructor(message: string) {
    super(message);
    this.name = "GitLocalStateError";
  }
}

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InvalidTaskStateError(`${label} must be non-empty`);
  }
  return normalized;
}

function assertRemoteName(remote: string): string {
  const normalized = assertNonEmpty(remote, "Git remote");
  if (!/^[A-Za-z0-9._-]+$/.test(normalized)) {
    throw new InvalidTaskStateError(`Git remote name is invalid: ${normalized}`);
  }
  return normalized;
}

function assertTargetRef(ref: string): string {
  const normalized = assertNonEmpty(ref, "Git target ref");
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(normalized) || normalized.includes("..") || normalized.endsWith("/")) {
    throw new InvalidTaskStateError(`Git target ref is invalid: ${normalized}`);
  }
  return normalized;
}

function formatCommandOutput(result: CommandResult): string {
  const output = [result.stdout.trim(), result.stderr.trim()].filter((value) => value.length > 0).join("\n");
  return output.length === 0 ? "Git command completed with no output" : redactSensitiveText(output);
}

function commandFailure(command: string, error: CommandExecutionError): GitLocalStateError {
  const output = formatCommandOutput(error.result);
  const exitCode = error.result.exitCode === null ? "no exit code" : String(error.result.exitCode);
  return new GitLocalStateError(`Unable to run git ${command}; exit code ${exitCode}; observed output: ${output}`);
}

async function runGitRead(repositoryPath: string | null, argumentsList: readonly string[], commandLabel: string): Promise<CommandResult> {
  return runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath }).then(
    (result) => result,
    (error: CommandExecutionError) => {
      if (!(error instanceof CommandExecutionError)) {
        throw new GitLocalStateError(`Unable to run git ${commandLabel}: command runner returned an untyped failure`);
      }
      throw commandFailure(commandLabel, error);
    },
  );
}

function outputValue(result: CommandResult, label: string): string {
  return assertNonEmpty(result.stdout, label);
}

export async function inspectLocalGitState(repositoryPath: string, remote: string, ref: string): Promise<LocalGitState> {
  const normalizedRemote = assertRemoteName(remote);
  const normalizedRef = assertTargetRef(ref);
  const root = outputValue(await runGitRead(repositoryPath, ["rev-parse", "--show-toplevel"], "rev-parse --show-toplevel"), "Git repository root");
  const branch = outputValue(await runGitRead(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], "symbolic-ref --short HEAD"), "Git branch");
  const head = outputValue(await runGitRead(repositoryPath, ["rev-parse", "HEAD"], "rev-parse HEAD"), "Git HEAD");
  if (!/^[a-f0-9]{40,64}$/i.test(head)) {
    throw new GitLocalStateError(`Git HEAD is not a full object id: ${head}`);
  }
  const worktreeStatus = (await runGitRead(repositoryPath, ["status", "--porcelain=v1"], "status --porcelain=v1")).stdout.trim();
  const remoteUrl = outputValue(await runGitRead(repositoryPath, ["config", "--get", `remote.${normalizedRemote}.url`], `config --get remote.${normalizedRemote}.url`), "Git remote URL");
  return {
    repositoryPath: root,
    branch,
    head,
    worktreeStatus,
    remote: normalizedRemote,
    remoteUrl,
    ref: normalizedRef,
  };
}

export async function pushGitRef(repositoryPath: string, remote: string, ref: string, head: string): Promise<GitPushResult> {
  const normalizedRemote = assertRemoteName(remote);
  const normalizedRef = assertTargetRef(ref);
  if (!/^[a-f0-9]{40,64}$/i.test(head)) {
    throw new InvalidTaskStateError("Git push HEAD must be a full Git object id");
  }
  return runCommand({ command: "git", arguments: ["push", normalizedRemote, `${head}:${normalizedRef}`], cwd: repositoryPath }).then(
    (result) => ({ pushed: true, observedOutput: formatCommandOutput(result), exitCode: 0 }),
    (error: CommandExecutionError) => {
      if (!(error instanceof CommandExecutionError)) {
        return { pushed: false, observedOutput: "Git push could not be started by the command runner", exitCode: -1 };
      }
      return {
        pushed: false,
        observedOutput: formatCommandOutput(error.result),
        exitCode: error.result.exitCode ?? -1,
      };
    },
  );
}

export async function readRemoteRef(repository: string, ref: string, repositoryPath: string | null): Promise<CommandResult> {
  const normalizedRepository = assertNonEmpty(repository, "Git remote repository");
  const normalizedRef = assertTargetRef(ref);
  return runGitRead(repositoryPath, ["ls-remote", normalizedRepository, normalizedRef], "ls-remote");
}

export function summarizeLocalGitState(state: LocalGitState): string {
  const worktree = state.worktreeStatus.length === 0 ? "clean" : state.worktreeStatus;
  return redactSensitiveText([
    `Repository root: ${state.repositoryPath}`,
    `Branch: ${state.branch}`,
    `HEAD: ${state.head}`,
    `Worktree status: ${worktree}`,
    `Remote: ${state.remote}`,
    `Target ref: ${state.ref}`,
  ].join("\n"));
}
