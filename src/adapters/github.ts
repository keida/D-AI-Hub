import { redactSensitiveText } from "./command-runner.js";
import { inspectLocalGitState, pushGitRef, readRemoteRef, summarizeLocalGitState } from "./git.js";
import { CloseBlockedError, InvalidTaskStateError } from "../domain/errors.js";

export interface GitPushEvidence {
  readonly remote: string;
  readonly repository: string;
  readonly ref: string;
  readonly localSha: string;
  readonly pushed: boolean;
  readonly observedOutput: string;
  readonly exitCode: number;
}

export interface RemoteState {
  readonly repository: string;
  readonly ref: string;
  readonly remoteSha: string;
  readonly matchesExpectedSha: boolean;
}

export interface GitHubAdapter {
  pushExpectedCommit(repositoryPath: string, remote: string, ref: string): Promise<GitPushEvidence>;
  verifyRemoteState(repository: string, ref: string, expectedSha: string): Promise<RemoteState>;
}

export interface GitHubRemotePolicy {
  readonly enterpriseHost: string | null;
}

export interface GitHubRepository {
  readonly host: string;
  readonly repository: string;
}

export class GitRemoteBlockedError extends CloseBlockedError {
  public constructor(message: string) {
    super(message);
    this.name = "GitRemoteBlockedError";
  }
}

interface RemoteEndpoint {
  readonly repository: string;
  readonly endpoint: string;
  readonly repositoryPath: string;
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.startsWith(".") || normalized.endsWith(".")) {
    throw new InvalidTaskStateError(`GitHub host is invalid: ${host}`);
  }
  return normalized;
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const segments = normalized.split("/");
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new GitRemoteBlockedError("Configured remote does not identify an unambiguous GitHub owner and repository");
  }
  const owner = segments[0];
  const repository = segments[1];
  if (owner === undefined || repository === undefined) {
    throw new GitRemoteBlockedError("Configured remote does not identify a GitHub owner and repository");
  }
  return `${owner}/${repository}`;
}

function parsedRemote(value: string): { readonly host: string; readonly path: string; readonly protocol: "https" | "ssh" } {
  const remote = value.trim();
  if (remote.length === 0) {
    throw new GitRemoteBlockedError("Configured Git remote URL is empty");
  }
  if (/^[^@\s]+@[^:\s]+:.+$/.test(remote)) {
    const separator = remote.indexOf(":");
    const at = remote.indexOf("@");
    const username = remote.slice(0, at);
    const host = remote.slice(at + 1, separator);
    if (username !== "git") {
      throw new GitRemoteBlockedError("Configured SSH remote must use the git account");
    }
    return { host, path: remote.slice(separator + 1), protocol: "ssh" };
  }
  let parsed: URL;
  try {
    parsed = new URL(remote);
  } catch {
    throw new GitRemoteBlockedError("Configured Git remote URL is malformed");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new GitRemoteBlockedError("Configured Git remote must use HTTPS or SSH");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new GitRemoteBlockedError("Configured Git remote URL must not contain a query or fragment");
  }
  if (parsed.protocol === "https:" && (parsed.username.length > 0 || parsed.password.length > 0)) {
    throw new GitRemoteBlockedError("Credential-bearing HTTPS remotes are not accepted for close verification");
  }
  if (parsed.protocol === "ssh:" && parsed.username !== "git") {
    throw new GitRemoteBlockedError("Configured SSH remote must use the git account");
  }
  return { host: parsed.hostname, path: parsed.pathname, protocol: parsed.protocol === "https:" ? "https" : "ssh" };
}

function assertAllowedHost(host: string, enterpriseHost: string | null): string {
  const normalizedHost = normalizeHost(host);
  const configuredEnterpriseHost = enterpriseHost === null ? null : normalizeHost(enterpriseHost);
  if (normalizedHost !== "github.com" && normalizedHost !== configuredEnterpriseHost) {
    throw new GitRemoteBlockedError(`Configured remote host ${normalizedHost} is not github.com or the explicit Enterprise host`);
  }
  return normalizedHost;
}

export function resolveGitHubRepository(remoteUrl: string, enterpriseHost: string | null): GitHubRepository {
  const remote = parsedRemote(remoteUrl);
  const host = assertAllowedHost(remote.host, enterpriseHost);
  return { host, repository: `${host}/${normalizeRepositoryPath(remote.path)}` };
}

function assertExpectedSha(expectedSha: string): string {
  const normalized = expectedSha.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(normalized)) {
    throw new InvalidTaskStateError("Expected remote SHA must be a full Git object id");
  }
  return normalized;
}

function remoteEndpoint(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 3) {
    throw new GitRemoteBlockedError("GitHub repository identity is malformed");
  }
  const host = parts[0];
  const owner = parts[1];
  const name = parts[2];
  if (host === undefined || owner === undefined || name === undefined) {
    throw new GitRemoteBlockedError("GitHub repository identity is incomplete");
  }
  return `https://${host}/${owner}/${name}.git`;
}

function parseRemoteSha(output: string, ref: string): string {
  const matches = output
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[1] === ref && /^[a-f0-9]{40,64}$/i.test(parts[0] ?? ""));
  if (matches.length > 1) {
    throw new GitRemoteBlockedError(`GitHub remote returned ambiguous SHA values for ${ref}`);
  }
  const match = matches[0];
  if (match === undefined) {
    return "";
  }
  const sha = match[0];
  if (sha === undefined) {
    throw new GitRemoteBlockedError(`GitHub remote returned malformed SHA output for ${ref}`);
  }
  return sha;
}

export class GitHubCliAdapter implements GitHubAdapter {
  private readonly enterpriseHost: string | null;
  private readonly endpoints = new Map<string, RemoteEndpoint>();

  public constructor(policy: GitHubRemotePolicy) {
    this.enterpriseHost = policy.enterpriseHost === null ? null : normalizeHost(policy.enterpriseHost);
  }

  public async pushExpectedCommit(repositoryPath: string, remote: string, ref: string): Promise<GitPushEvidence> {
    const localState = await inspectLocalGitState(repositoryPath, remote, ref);
    const remoteRepository = resolveGitHubRepository(localState.remoteUrl, this.enterpriseHost);
    const localEvidence = summarizeLocalGitState(localState);
    if (localState.worktreeStatus.length > 0) {
      return {
        remote: localState.remote,
        repository: remoteRepository.repository,
        ref: localState.ref,
        localSha: localState.head,
        pushed: false,
        observedOutput: `${localEvidence}\nPush was not attempted because the required clean worktree policy failed.`,
        exitCode: 1,
      };
    }
    const pushResult = await pushGitRef(localState.repositoryPath, localState.remote, localState.ref, localState.head);
    if (pushResult.pushed) {
      this.endpoints.set(remoteRepository.repository, {
        repository: remoteRepository.repository,
        endpoint: localState.remoteUrl,
        repositoryPath: localState.repositoryPath,
      });
    }
    return {
      remote: localState.remote,
      repository: remoteRepository.repository,
      ref: localState.ref,
      localSha: localState.head,
      pushed: pushResult.pushed,
      observedOutput: redactSensitiveText(`${localEvidence}\nPush output: ${pushResult.observedOutput}`),
      exitCode: pushResult.exitCode,
    };
  }

  public async verifyRemoteState(repository: string, ref: string, expectedSha: string): Promise<RemoteState> {
    const expected = assertExpectedSha(expectedSha);
    const parts = repository.split("/");
    const host = parts[0];
    if (host === undefined) {
      throw new GitRemoteBlockedError("GitHub repository identity is empty");
    }
    assertAllowedHost(host, this.enterpriseHost);
    const recordedEndpoint = this.endpoints.get(repository);
    const endpoint = recordedEndpoint?.endpoint ?? remoteEndpoint(repository);
    const result = await readRemoteRef(endpoint, ref, recordedEndpoint?.repositoryPath ?? null);
    const remoteSha = parseRemoteSha(result.stdout, ref);
    return { repository, ref, remoteSha, matchesExpectedSha: remoteSha === expected };
  }
}
