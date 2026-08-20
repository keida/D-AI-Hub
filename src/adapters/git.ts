import { CommandExecutionError, redactSensitiveText, runCommand, type CommandResult } from "./command-runner.js";
import { CloseBlockedError, InvalidTaskStateError } from "../domain/errors.js";

export interface LocalGitState {
  readonly repositoryPath: string;
  readonly branch: string;
  readonly head: string;
  readonly worktreeStatus: string;
  readonly remote: string;
  readonly remoteUrl: string;
  readonly pushUrl: string;
  readonly ref: string;
}

export type GitFailureCategory =
  | "authentication"
  | "permission"
  | "network"
  | "remote-unavailable"
  | "ambiguous"
  | "verification-mismatch"
  | "dirty-worktree";

export interface GitPushResult {
  readonly pushed: boolean;
  readonly observedOutput: string;
  readonly exitCode: number;
  readonly failureCategory: GitFailureCategory | null;
}

export interface GitTransport {
  pushRef(repositoryPath: string, endpoint: string, ref: string, head: string): Promise<GitPushResult>;
  readRef(repositoryPath: string, endpoint: string, ref: string): Promise<CommandResult>;
}

export class GitLocalStateError extends CloseBlockedError {
  public readonly category: GitFailureCategory;

  public constructor(category: GitFailureCategory, message: string) {
    super(message);
    this.name = "GitLocalStateError";
    this.category = category;
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
  return new GitLocalStateError(classifyGitFailure(output), `Unable to run git ${command}; exit code ${exitCode}; observed output: ${output}`);
}

async function runGitRead(repositoryPath: string | null, argumentsList: readonly string[], commandLabel: string): Promise<CommandResult> {
  return runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath }).then(
    (result) => result,
    (error: CommandExecutionError) => {
      if (!(error instanceof CommandExecutionError)) {
        throw new GitLocalStateError("ambiguous", `Unable to run git ${commandLabel}: command runner returned an untyped failure`);
      }
      throw commandFailure(commandLabel, error);
    },
  );
}

function outputValue(result: CommandResult, label: string): string {
  return assertNonEmpty(result.stdout, label);
}

function oneOutputLine(result: CommandResult, label: string): string {
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length !== 1) {
    throw new GitLocalStateError("ambiguous", `${label} must resolve to exactly one endpoint; observed ${lines.length}`);
  }
  const value = lines[0];
  if (value === undefined) {
    throw new GitLocalStateError("ambiguous", `${label} did not resolve to an endpoint`);
  }
  return value;
}

export function classifyGitFailure(observedOutput: string): GitFailureCategory {
  const output = observedOutput.toLowerCase();
  if (/authentication failed|could not read username|terminal prompts disabled|invalid username or password/.test(output)) {
    return "authentication";
  }
  if (/permission denied|write access.*not granted|http 403|status code: 403|requested url returned error: 403/.test(output)) {
    return "permission";
  }
  if (/could not resolve host|failed to connect|connection (?:timed out|refused|reset)|network is unreachable|unable to access.*ssl/.test(output)) {
    return "network";
  }
  if (/repository(?: .*?)? not found|does not appear to be a git repository|remote end hung up|http 5\d\d|requested url returned error: 5\d\d/.test(output)) {
    return "remote-unavailable";
  }
  if (/non-fast-forward|fetch first|stale info|\[rejected\]|rejected by remote/.test(output)) {
    return "verification-mismatch";
  }
  return "ambiguous";
}

export async function inspectLocalGitState(repositoryPath: string, remote: string, ref: string): Promise<LocalGitState> {
  const normalizedRemote = assertRemoteName(remote);
  const normalizedRef = assertTargetRef(ref);
  const root = outputValue(await runGitRead(repositoryPath, ["rev-parse", "--show-toplevel"], "rev-parse --show-toplevel"), "Git repository root");
  const branch = outputValue(await runGitRead(repositoryPath, ["symbolic-ref", "--quiet", "--short", "HEAD"], "symbolic-ref --short HEAD"), "Git branch");
  const head = outputValue(await runGitRead(repositoryPath, ["rev-parse", "HEAD"], "rev-parse HEAD"), "Git HEAD");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) {
    throw new GitLocalStateError("ambiguous", `Git HEAD is not a full object id: ${head}`);
  }
  const worktreeStatus = (await runGitRead(repositoryPath, ["status", "--porcelain=v1"], "status --porcelain=v1")).stdout.trim();
  const remoteUrl = outputValue(await runGitRead(repositoryPath, ["config", "--get", `remote.${normalizedRemote}.url`], `config --get remote.${normalizedRemote}.url`), "Git remote URL");
  const pushUrl = oneOutputLine(
    await runGitRead(repositoryPath, ["remote", "get-url", "--push", "--all", normalizedRemote], `remote get-url --push --all ${normalizedRemote}`),
    "Effective Git push transport",
  );
  return {
    repositoryPath: root,
    branch,
    head,
    worktreeStatus,
    remote: normalizedRemote,
    remoteUrl,
    pushUrl,
    ref: normalizedRef,
  };
}

export async function pushGitRef(repositoryPath: string, endpoint: string, ref: string, head: string): Promise<GitPushResult> {
  const normalizedEndpoint = assertNonEmpty(endpoint, "Git push endpoint");
  const normalizedRef = assertTargetRef(ref);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) {
    throw new InvalidTaskStateError("Git push HEAD must be a full Git object id");
  }
  return runCommand({ command: "git", arguments: ["push", normalizedEndpoint, `${head}:${normalizedRef}`], cwd: repositoryPath }).then(
    (result) => ({ pushed: true, observedOutput: formatCommandOutput(result), exitCode: 0, failureCategory: null }),
    (error: CommandExecutionError) => {
      if (!(error instanceof CommandExecutionError)) {
        return {
          pushed: false,
          observedOutput: "Git push could not be started by the command runner",
          exitCode: -1,
          failureCategory: "ambiguous" as const,
        };
      }
      const observedOutput = formatCommandOutput(error.result);
      return {
        pushed: false,
        observedOutput,
        exitCode: error.result.exitCode ?? -1,
        failureCategory: classifyGitFailure(observedOutput),
      };
    },
  );
}

export async function readRemoteRef(repository: string, ref: string, repositoryPath: string | null): Promise<CommandResult> {
  const normalizedRepository = assertNonEmpty(repository, "Git remote repository");
  const normalizedRef = assertTargetRef(ref);
  return runGitRead(repositoryPath, ["ls-remote", normalizedRepository, normalizedRef], "ls-remote");
}

export const gitCliTransport: GitTransport = {
  pushRef: async (repositoryPath, endpoint, ref, head) => pushGitRef(repositoryPath, endpoint, ref, head),
  readRef: async (repositoryPath, endpoint, ref) => readRemoteRef(endpoint, ref, repositoryPath),
};

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
