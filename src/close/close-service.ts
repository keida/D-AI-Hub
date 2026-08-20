import { redactSensitiveText } from "../adapters/command-runner.js";
import type { GitHubAdapter, GitPushEvidence, RemoteState } from "../adapters/github.js";
import { CloseBlockedError } from "../domain/errors.js";
import type { CloseVerdict, DurableContextManifest, TaskState, VerificationEvidence } from "../domain/types.js";
import type { DurableContextStore } from "../state/durable-context-store.js";
import { evaluateHardGates, type GateEvidence, type GateName } from "../verification/gates.js";

const maximumEvidenceAgeMs = 5 * 60 * 1_000;
const evidenceGateNames = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "recovery",
  "handoff",
  "durable-context",
  "critical-unsaved-context",
] as const satisfies readonly GateName[];

interface CloseConfiguration {
  readonly repositoryPath: string;
  readonly remote: string;
  readonly ref: string;
}

interface PreflightResult {
  readonly reasons: readonly string[];
  readonly configuration: CloseConfiguration | null;
}

function selectedModel(state: TaskState): string {
  return state.routingDecision?.selectedModel.trim() || "unrecorded-model";
}

function createVerdict(state: TaskState, status: CloseVerdict["status"], reasons: readonly string[], evidence: readonly VerificationEvidence[]): CloseVerdict {
  return {
    taskId: state.taskId,
    status,
    stage: state.stage,
    environment: state.environment,
    role: state.role,
    selectedModel: selectedModel(state),
    evidence,
    recoveryPoint: state.recoveryPoint,
    durablePaths: state.durableContext?.durablePaths ?? [],
    hashes: state.durableContext?.hashes ?? {},
    reasons: reasons.map(redactSensitiveText),
  };
}

function failure(reason: string, nextCheck: string): string {
  return `${reason}. Next check: ${nextCheck}.`;
}

function oneManifestValue(values: readonly string[], prefix: string, label: string, reasons: string[]): string | null {
  const matches = values.filter((value) => value.startsWith(prefix));
  if (matches.length !== 1) {
    reasons.push(failure(`${label} is missing or ambiguous`, `record exactly one ${prefix}<value> context manifest entry`));
    return null;
  }
  const value = matches[0]?.slice(prefix.length).trim() ?? "";
  if (value.length === 0) {
    reasons.push(failure(`${label} is empty`, `record a non-empty ${prefix}<value> context manifest entry`));
    return null;
  }
  return value;
}

function repositoryPathFromManifest(values: readonly string[], reasons: string[]): string | null {
  const entries = values.filter((value) => value.startsWith("identity:repository:"));
  if (entries.length !== 1) {
    reasons.push(failure("Repository identity is missing or ambiguous", "record exactly one repository identity during bootstrap"));
    return null;
  }
  const match = /^identity:repository:(.+):[a-f0-9]{64}$/i.exec(entries[0] ?? "");
  if (match === null || match[1]?.trim().length === 0) {
    reasons.push(failure("Repository identity is malformed", "re-bootstrap the task against the intended repository"));
    return null;
  }
  const repositoryPath = match[1];
  if (repositoryPath === undefined) {
    reasons.push(failure("Repository identity is malformed", "re-bootstrap the task against the intended repository"));
    return null;
  }
  return repositoryPath;
}

function hasExactArtifacts(manifest: DurableContextManifest, state: TaskState): boolean {
  if (manifest.durablePaths.length === 0 || Object.keys(manifest.hashes).length !== manifest.durablePaths.length) {
    return false;
  }
  if (manifest.durablePaths.some((path) => path.trim().length === 0 || !/^[a-f0-9]{64}$/i.test(manifest.hashes[path] ?? ""))) {
    return false;
  }
  const recoveryPoint = state.recoveryPoint;
  if (recoveryPoint === null || recoveryPoint.recoveryPointId !== manifest.recoveryPointId) {
    return false;
  }
  if (recoveryPoint.durablePaths.length === 0 || recoveryPoint.durablePaths.some((path) => !/^[a-f0-9]{64}$/i.test(recoveryPoint.hashes[path] ?? ""))) {
    return false;
  }
  return state.verificationEvidence.every((evidence) => evidence.recoveryPointId === recoveryPoint.recoveryPointId);
}

function gateName(evidence: VerificationEvidence): GateName | null {
  const name = evidence.evidenceId.startsWith("gate:") ? evidence.evidenceId.slice("gate:".length) : "";
  return evidenceGateNames.some((candidate) => candidate === name) ? name as GateName : null;
}

function gateEvidence(state: TaskState): readonly GateEvidence[] {
  return state.verificationEvidence.flatMap((verification) => {
    const gate = gateName(verification);
    return gate === null ? [] : [{ gate, verification }];
  });
}

function preflight(state: TaskState, now: Date): PreflightResult {
  const reasons: string[] = [];
  if (state.stage !== "close") {
    reasons.push(failure("Close was not explicitly invoked", "transition the verified task to the close stage before evaluating close"));
  }
  if (state.handoffState !== "completed") {
    reasons.push(failure(`Close has unresolved handoff state ${state.handoffState}`, "complete or explicitly resolve the handoff"));
  }
  if (state.approvalState === "pending" || state.approvalState === "rejected") {
    reasons.push(failure(`Close approval is ${state.approvalState}`, "resolve the recorded approval before close"));
  }
  if (state.criticalUnsavedContext.length > 0) {
    reasons.push(failure("Critical unsaved context remains", "persist or explicitly resolve every critical context item"));
  }
  if (state.durableContext === null) {
    reasons.push(failure("Durable context manifest is missing", "save the task state and durable artifact manifest"));
  } else if (!hasExactArtifacts(state.durableContext, state)) {
    reasons.push(failure("Required durable artifact correspondence is incomplete", "restore the durable artifact manifest and matching recovery point"));
  }
  const repositoryPath = repositoryPathFromManifest(state.contextManifest, reasons);
  const remote = oneManifestValue(state.contextManifest, "remote:", "Configured remote", reasons);
  const ref = oneManifestValue(state.contextManifest, "ref:", "Target ref", reasons);
  const policy = oneManifestValue(state.contextManifest, "local-state:", "Local-state policy", reasons);
  if (policy !== null && policy !== "clean-required") {
    reasons.push(failure("Local-state policy is not the supported clean-required policy", "record local-state:clean-required before close"));
  }
  const gateResults = evaluateHardGates({ state, evidence: gateEvidence(state), now, maximumEvidenceAgeMs });
  for (const result of gateResults) {
    if (result.gate !== "remote-durability" && result.gate !== "close" && !result.passed) {
      reasons.push(failure(`Hard gate ${result.gate} failed: ${result.reason}`, "rerun and record fresh passing evidence for this gate"));
    }
  }
  if (repositoryPath === null || remote === null || ref === null || policy === null || reasons.length > 0) {
    return { reasons, configuration: null };
  }
  return { reasons, configuration: { repositoryPath, remote, ref } };
}

function pushEvidence(state: TaskState, evidence: GitPushEvidence, now: string): VerificationEvidence {
  return {
    evidenceId: "close:git-push",
    stage: state.stage,
    environment: state.environment,
    role: state.role,
    selectedModel: selectedModel(state),
    command: `git push ${evidence.remote} ${evidence.ref}`,
    observedOutput: evidence.observedOutput,
    exitCode: evidence.exitCode,
    interpretation: evidence.pushed ? "Git push command completed" : "Git push command did not complete",
    passed: evidence.pushed && evidence.exitCode === 0,
    recoveryPointId: state.recoveryPoint?.recoveryPointId ?? null,
    recordedAt: now,
  };
}

function remoteEvidence(state: TaskState, remote: RemoteState, now: string): VerificationEvidence {
  return {
    evidenceId: "close:remote-sha",
    stage: state.stage,
    environment: state.environment,
    role: state.role,
    selectedModel: selectedModel(state),
    command: `git ls-remote ${remote.repository} ${remote.ref}`,
    observedOutput: remote.remoteSha.length === 0 ? "Remote ref was not found" : `Remote SHA: ${remote.remoteSha}`,
    exitCode: remote.remoteSha.length === 0 ? 1 : 0,
    interpretation: remote.matchesExpectedSha ? "Remote SHA matches the pushed commit" : "Remote SHA does not match the pushed commit",
    passed: remote.matchesExpectedSha,
    recoveryPointId: state.recoveryPoint?.recoveryPointId ?? null,
    recordedAt: now,
  };
}

function blockedReason(error: Error, nextCheck: string): string {
  return failure(`Close verification is blocked: ${redactSensitiveText(error.message)}`, nextCheck);
}

export async function closeTask(
  state: TaskState,
  dependencies: { readonly store: DurableContextStore; readonly gitHub: GitHubAdapter },
): Promise<CloseVerdict> {
  const now = new Date();
  const persistedState = await dependencies.store.load(state.taskId).then(
    (loaded) => loaded,
    (error: Error) => {
      if (error instanceof CloseBlockedError) {
        return Promise.reject(error);
      }
      return Promise.reject(new CloseBlockedError(`Durable context could not be loaded for close: ${redactSensitiveText(error.message)}`));
    },
  ).then(
    (loaded) => loaded,
    (error: Error) => {
      if (!(error instanceof CloseBlockedError)) {
        throw error;
      }
      return null;
    },
  );
  if (persistedState === null) {
    return createVerdict(state, "BLOCKED", [failure("Durable task state is unavailable or could not be read", "restore durable task state and rerun close")], state.verificationEvidence);
  }
  if (JSON.stringify(persistedState) !== JSON.stringify(state)) {
    return createVerdict(state, "BLOCKED", [failure("Persisted task state does not match the state submitted for close", "reload the task from durable storage before close")], state.verificationEvidence);
  }
  const preflightResult = preflight(state, now);
  if (preflightResult.configuration === null) {
    return createVerdict(state, "NO", preflightResult.reasons, state.verificationEvidence);
  }
  const configuration = preflightResult.configuration;
  const pushResult = await dependencies.gitHub.pushExpectedCommit(configuration.repositoryPath, configuration.remote, configuration.ref).then(
    (value) => ({ value, error: null as Error | null }),
    (error: Error) => ({ value: null as GitPushEvidence | null, error }),
  );
  if (pushResult.error !== null || pushResult.value === null) {
    return createVerdict(state, "BLOCKED", [blockedReason(pushResult.error ?? new CloseBlockedError("GitHub push returned no evidence"), "check remote reachability, permissions, and configured host")], state.verificationEvidence);
  }
  const recordedPushEvidence = pushEvidence(state, pushResult.value, now.toISOString());
  if (!pushResult.value.pushed || pushResult.value.exitCode !== 0) {
    const reason = /worktree status:/i.test(pushResult.value.observedOutput)
      ? failure("Local worktree is not clean", "commit, stash, or explicitly resolve the local worktree before close")
      : failure("GitHub push did not succeed", "inspect the recorded push output and resolve the remote rejection");
    return createVerdict(state, "NO", [reason], [...state.verificationEvidence, recordedPushEvidence]);
  }
  if (!state.contextManifest.includes(`artifact:commit:${pushResult.value.localSha}`)) {
    return createVerdict(state, "NO", [failure("Durable artifact manifest does not identify the pushed commit", "record artifact:commit:<full-sha> in durable context and rerun verification")], [...state.verificationEvidence, recordedPushEvidence]);
  }
  const remoteResult = await dependencies.gitHub.verifyRemoteState(pushResult.value.repository, pushResult.value.ref, pushResult.value.localSha).then(
    (value) => ({ value, error: null as Error | null }),
    (error: Error) => ({ value: null as RemoteState | null, error }),
  );
  if (remoteResult.error !== null || remoteResult.value === null) {
    return createVerdict(state, "BLOCKED", [blockedReason(remoteResult.error ?? new CloseBlockedError("GitHub remote verification returned no state"), "check remote reachability, permissions, and the configured GitHub host")], [...state.verificationEvidence, recordedPushEvidence]);
  }
  const recordedRemoteEvidence = remoteEvidence(state, remoteResult.value, now.toISOString());
  if (remoteResult.value.repository !== pushResult.value.repository || remoteResult.value.ref !== pushResult.value.ref) {
    return createVerdict(state, "BLOCKED", [failure("Remote verification returned a different repository or ref", "verify the configured remote and target ref are unambiguous")], [...state.verificationEvidence, recordedPushEvidence, recordedRemoteEvidence]);
  }
  if (!remoteResult.value.matchesExpectedSha || remoteResult.value.remoteSha !== pushResult.value.localSha) {
    return createVerdict(state, "NO", [failure("Remote SHA does not match the pushed commit", "inspect the remote ref and push the intended commit again")], [...state.verificationEvidence, recordedPushEvidence, recordedRemoteEvidence]);
  }
  return createVerdict(state, "YES", [], [...state.verificationEvidence, recordedPushEvidence, recordedRemoteEvidence]);
}
