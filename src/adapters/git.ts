import { CommandExecutionError, redactSensitiveText, runCommand, type CommandResult } from "./command-runner.js";
import { CloseBlockedError, InvalidTaskStateError } from "../domain/errors.js";
import { isAbsolute, relative, resolve } from "node:path";

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

interface GitUrlRewriteRule {
  readonly base: string;
  readonly prefix: string;
}

export class GitLocalStateError extends CloseBlockedError {
  public readonly category: GitFailureCategory;

  public constructor(category: GitFailureCategory, message: string) {
    super(message);
    this.name = "GitLocalStateError";
    this.category = category;
  }
}

function durableStatePath(repositoryRoot: string, workspacePath: string): string {
  const workspaceRelativePath = relative(repositoryRoot, resolve(workspacePath)).replaceAll("\\", "/");
  if (isAbsolute(workspaceRelativePath) || workspaceRelativePath === ".." || workspaceRelativePath.startsWith("../")) {
    throw new GitLocalStateError("ambiguous", "Configured workspace must be inside the Git repository root");
  }
  return workspaceRelativePath.length === 0 ? ".d-ai" : `${workspaceRelativePath}/.d-ai`;
}

export function literalExcludePathspec(path: string): string {
  return `:(exclude,literal)${path}`;
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

export function isValidGitBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9._/@-]+$/.test(value) || value.startsWith("-") || value === "@" || value.includes("@{") || value.includes("..") || value.includes("//") || value.startsWith("/") || value.endsWith("/")) return false;
  return value.split("/").every((segment) => segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".") && !/\.lock$/i.test(segment));
}

export function isValidGitTargetRef(value: string): boolean {
  return value.startsWith("refs/heads/") && isValidGitBranchName(value.slice("refs/heads/".length));
}

function assertTargetRef(ref: string): string {
  const normalized = assertNonEmpty(ref, "Git target ref");
  if (!isValidGitTargetRef(normalized)) {
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
  return runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath, timeoutMs: 30_000, maxOutputBytes: 1_048_576 }).then(
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

async function runGitOptionalConfigQuery(
  repositoryPath: string,
  argumentsList: readonly string[],
  commandLabel: string,
): Promise<CommandResult | null> {
  return runCommand({ command: "git", arguments: argumentsList, cwd: repositoryPath, timeoutMs: 30_000, maxOutputBytes: 1_048_576 }).then(
    (result) => result,
    (error: CommandExecutionError) => {
      if (!(error instanceof CommandExecutionError)) {
        throw new GitLocalStateError("ambiguous", `Unable to run git ${commandLabel}: command runner returned an untyped failure`);
      }
      if (error.result.exitCode === 1 && error.result.stdout.length === 0 && error.result.stderr.length === 0) {
        return null;
      }
      throw commandFailure(commandLabel, error);
    },
  );
}

function parseNullTerminatedValues(output: string, label: string): readonly string[] {
  const values = output.split("\0");
  const trailingValue = values.pop();
  if (trailingValue !== "") {
    throw new GitLocalStateError("ambiguous", `${label} has malformed command output`);
  }
  return values;
}

async function readGitConfigValues(repositoryPath: string, key: string, label: string): Promise<readonly string[]> {
  const result = await runGitOptionalConfigQuery(repositoryPath, ["config", "--null", "--get-all", key], `config --get-all ${key}`);
  return result === null ? [] : parseNullTerminatedValues(result.stdout, label);
}

function parseGitUrlRewriteRules(output: string): readonly GitUrlRewriteRule[] {
  const records = output.split("\0");
  const trailingRecord = records.pop();
  if (trailingRecord !== "") {
    throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration has malformed command output");
  }
  return records.map((record) => {
    const separator = record.indexOf("\n");
    if (separator <= 4) {
      throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration contains a malformed rule");
    }
    const key = record.slice(0, separator);
    const normalizedKey = key.toLowerCase();
    const suffix = normalizedKey.endsWith(".pushinsteadof") ? ".pushinsteadof" : ".insteadof";
    if (!normalizedKey.startsWith("url.") || !normalizedKey.endsWith(suffix)) {
      throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration contains an unexpected rule");
    }
    const base = key.slice(4, -suffix.length);
    const prefix = record.slice(separator + 1);
    if (base.length === 0 || prefix.length === 0) {
      throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration contains an empty base or prefix");
    }
    return { base, prefix };
  });
}

async function readGitUrlRewriteRules(repositoryPath: string): Promise<readonly GitUrlRewriteRule[]> {
  const result = await runGitOptionalConfigQuery(
    repositoryPath,
    ["config", "--includes", "--null", "--get-regexp", "^url\\..*\\.(insteadof|pushinsteadof)$"],
    "config --get-regexp URL rewrites",
  );
  return result === null ? [] : parseGitUrlRewriteRules(result.stdout);
}

function rewriteGitUrlOnce(endpoint: string, rules: readonly GitUrlRewriteRule[]): string | null {
  const matchingRules = rules.filter((rule) => endpoint.startsWith(rule.prefix));
  if (matchingRules.length === 0) {
    return null;
  }
  const longestPrefixLength = Math.max(...matchingRules.map((rule) => rule.prefix.length));
  const rewrittenEndpoints = new Set(
    matchingRules
      .filter((rule) => rule.prefix.length === longestPrefixLength)
      .map((rule) => `${rule.base}${endpoint.slice(rule.prefix.length)}`),
  );
  if (rewrittenEndpoints.size !== 1) {
    throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration has ambiguous longest-prefix rules");
  }
  const rewrittenEndpoint = rewrittenEndpoints.values().next().value;
  if (rewrittenEndpoint === undefined) {
    throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration did not produce an endpoint");
  }
  return rewrittenEndpoint;
}

export async function resolveGitEndpoint(repositoryPath: string, endpoint: string): Promise<string> {
  const normalizedEndpoint = assertNonEmpty(endpoint, "Git endpoint");
  const rules = await readGitUrlRewriteRules(repositoryPath);
  const visited = new Set<string>([normalizedEndpoint]);
  let resolvedEndpoint = normalizedEndpoint;
  for (let step = 0; step <= rules.length; step += 1) {
    const rewrittenEndpoint = rewriteGitUrlOnce(resolvedEndpoint, rules);
    if (rewrittenEndpoint === null) {
      return resolvedEndpoint;
    }
    if (visited.has(rewrittenEndpoint)) {
      throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration contains a cycle");
    }
    visited.add(rewrittenEndpoint);
    resolvedEndpoint = rewrittenEndpoint;
  }
  throw new GitLocalStateError("ambiguous", "Git URL rewrite configuration does not reach a fixed endpoint");
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

export async function inspectLocalGitState(repositoryPath: string, remote: string, ref: string, workspacePath = repositoryPath): Promise<LocalGitState> {
  const normalizedRemote = assertRemoteName(remote);
  const normalizedRef = assertTargetRef(ref);
  const root = await resolveGitRepositoryRoot(repositoryPath);
  const branch = outputValue(await runGitRead(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], "symbolic-ref --short HEAD"), "Git branch");
  if (!isValidGitBranchName(branch)) {
    throw new GitLocalStateError("ambiguous", `Git branch is malformed: ${branch}`);
  }
  if (`refs/heads/${branch}` !== normalizedRef) {
    throw new GitLocalStateError("verification-mismatch", `Git branch ${branch} does not match configured target ref ${normalizedRef}`);
  }
  const head = outputValue(await runGitRead(root, ["rev-parse", "HEAD"], "rev-parse HEAD"), "Git HEAD");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) {
    throw new GitLocalStateError("ambiguous", `Git HEAD is not a full object id: ${head}`);
  }
  const durablePath = durableStatePath(root, workspacePath);
  const statusArguments = ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", literalExcludePathspec(durablePath)];
  const worktreeStatus = (await runGitRead(
    root,
    statusArguments,
    `status --porcelain=v1 (excluding durable ${durablePath})`,
  )).stdout.trim();
  const remoteUrls = await readGitConfigValues(root, `remote.${normalizedRemote}.url`, "Git remote URL");
  if (remoteUrls.length !== 1) {
    throw new GitLocalStateError("ambiguous", `Git remote URL must resolve to exactly one endpoint; observed ${remoteUrls.length}`);
  }
  const remoteUrl = remoteUrls[0];
  if (remoteUrl === undefined) {
    throw new GitLocalStateError("ambiguous", "Git remote URL did not resolve to an endpoint");
  }
  const pushUrls = await readGitConfigValues(root, `remote.${normalizedRemote}.pushurl`, "Git push URL");
  if (pushUrls.length > 1) {
    throw new GitLocalStateError("ambiguous", `Git push URL must resolve to at most one endpoint; observed ${pushUrls.length}`);
  }
  const configuredPushUrl = pushUrls[0] ?? remoteUrl;
  const pushUrl = await resolveGitEndpoint(root, configuredPushUrl);
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

export async function resolveGitRepositoryRoot(repositoryPath: string): Promise<string> {
  return outputValue(
    await runGitRead(null, ["-C", repositoryPath, "rev-parse", "--show-toplevel"], "rev-parse --show-toplevel"),
    "Git repository root",
  );
}

export async function inspectCurrentGitState(repositoryPath: string, remote: string): Promise<LocalGitState> {
  const root = await resolveGitRepositoryRoot(repositoryPath);
  const branch = outputValue(await runGitRead(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], "symbolic-ref --short HEAD"), "Git branch");
  if (!isValidGitBranchName(branch)) {
    throw new GitLocalStateError("ambiguous", `Git branch is invalid: ${branch}`);
  }
  return inspectLocalGitState(root, remote, `refs/heads/${branch}`, repositoryPath);
}

export async function pushGitRef(repositoryPath: string, endpoint: string, ref: string, head: string): Promise<GitPushResult> {
  const normalizedEndpoint = assertNonEmpty(endpoint, "Git push endpoint");
  const normalizedRef = assertTargetRef(ref);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) {
    throw new InvalidTaskStateError("Git push HEAD must be a full Git object id");
  }
  return runCommand({ command: "git", arguments: ["push", normalizedEndpoint, `${head}:${normalizedRef}`], cwd: repositoryPath, timeoutMs: 60_000, maxOutputBytes: 1_048_576 }).then(
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
