import { describe, expect, it } from "vitest";
import { GitRemoteBlockedError } from "../../src/adapters/github.js";
import { closeTask } from "../../src/close/close-service.js";
import type { DurableContextStore } from "../../src/state/durable-context-store.js";
import type { GitHubAdapter, GitPushEvidence, RemoteState } from "../../src/adapters/github.js";
import type { GitFailureCategory } from "../../src/adapters/git.js";
import type { DurableContextManifest, TaskState, VerificationEvidence } from "../../src/domain/types.js";

const gateNames = [
  "scope",
  "environment-capability",
  "task-state",
  "quality",
  "failure-handling",
  "recovery",
  "handoff",
  "durable-context",
  "critical-unsaved-context",
] as const;

function manifest(now: string): DurableContextManifest {
  return {
    manifestId: "manifest-close",
    taskId: "task-close",
    stage: "close",
    environment: "codex",
    role: "evidence-collector",
    durablePaths: ["artifacts/context.json", "artifacts/evidence.json", "artifacts/recovery.json"],
    hashes: {
      "artifacts/context.json": "a".repeat(64),
      "artifacts/evidence.json": "b".repeat(64),
      "artifacts/recovery.json": "c".repeat(64),
    },
    recoveryPointId: "recovery-close",
    recordedAt: now,
  };
}

function evidence(now: string): readonly VerificationEvidence[] {
  return gateNames.map((gate) => ({
    evidenceId: `gate:${gate}`,
    stage: "close",
    environment: "codex",
    role: "evidence-collector",
    selectedModel: "verification-model",
    command: "npm test",
    observedOutput: "verification passed",
    exitCode: 0,
    interpretation: "Verification passed",
    passed: true,
    recoveryPointId: "recovery-close",
    recordedAt: now,
  }));
}

function closeReadyState(now: string): TaskState {
  const durableContext = manifest(now);
  return {
    taskId: "task-close",
    goal: "Verify close safety",
    constraints: ["No destructive cleanup"],
    environment: "codex",
    stage: "close",
    role: "evidence-collector",
    routingDecision: {
      stage: "close",
      environment: "codex",
      role: "evidence-collector",
      selectedModel: "verification-model",
      selectedCapabilities: ["shell"],
      reason: "Collect final local Git evidence",
      overrideSource: "default",
    },
    selectedCapabilities: ["shell"],
    contextManifest: [
      "identity:repository:C:/repo:" + "d".repeat(64),
      "remote:origin",
      "ref:refs/heads/main",
      "local-state:clean-required",
      "artifact:commit:" + "e".repeat(40),
    ],
    handoffState: "completed",
    verificationEvidence: evidence(now),
    recoveryPoint: {
      recoveryPointId: "recovery-close",
      taskId: "task-close",
      stage: "close",
      environment: "codex",
      role: "evidence-collector",
      durablePaths: durableContext.durablePaths,
      hashes: durableContext.hashes,
      restorationInstructions: "Restore the recorded recovery point without deleting user work.",
      createdAt: now,
    },
    approvalState: "approved",
    criticalUnsavedContext: [],
    durableContext,
  };
}

function storeFor(state: TaskState | null): DurableContextStore {
  return {
    load: async (): Promise<TaskState | null> => state,
    save: async (): Promise<DurableContextManifest> => {
      throw new Error("The close workflow must not save durable context");
    },
    recordCriticalUnsavedContext: async (): Promise<void> => {
      throw new Error("The close workflow must not record unsaved context");
    },
    clearCriticalUnsavedContext: async (): Promise<void> => {
      throw new Error("The close workflow must not clear unsaved context");
    },
  };
}

function successfulPush(): GitPushEvidence {
  return {
    remote: "origin",
    repository: "github.com/acme/d-ai",
    ref: "refs/heads/main",
    localSha: "e".repeat(40),
    pushed: true,
    observedOutput: "Git push completed",
    exitCode: 0,
    failureCategory: null,
  };
}

function matchingRemoteState(expectedSha: string): RemoteState {
  return {
    repository: "github.com/acme/d-ai",
    ref: "refs/heads/main",
    remoteSha: expectedSha,
    matchesExpectedSha: true,
  };
}

function gitHubFor(pushEvidence: GitPushEvidence, remoteState: RemoteState): GitHubAdapter {
  return {
    pushExpectedCommit: async (): Promise<GitPushEvidence> => pushEvidence,
    verifyRemoteState: async (): Promise<RemoteState> => remoteState,
  };
}

function unexpectedGitHub(): GitHubAdapter {
  return {
    pushExpectedCommit: async (): Promise<GitPushEvidence> => {
      throw new Error("GitHub adapter must not run after a failed close preflight");
    },
    verifyRemoteState: async (): Promise<RemoteState> => {
      throw new Error("GitHub adapter must not run after a failed close preflight");
    },
  };
}

describe("closeTask", () => {
  it("returns YES only after persisted state, fresh gates, a successful push, and an exact remote SHA match", async () => {
    const now = new Date().toISOString();
    const state = closeReadyState(now);
    const pushEvidence = successfulPush();

    const verdict = await closeTask(state, {
      store: storeFor(state),
      gitHub: gitHubFor(pushEvidence, matchingRemoteState(pushEvidence.localSha)),
    });

    expect(verdict.status).toBe("YES");
    expect(verdict.reasons).toEqual([]);
  });

  it("accepts an exact 64-character commit artifact and matching adapter evidence", async () => {
    const now = new Date().toISOString();
    const state = closeReadyState(now);
    const commitSha = "e".repeat(64);
    const contextManifest = state.contextManifest.map((entry) => entry.startsWith("artifact:commit:") ? `artifact:commit:${commitSha}` : entry);
    const stateWithSha256 = { ...state, contextManifest };
    const pushEvidence = { ...successfulPush(), localSha: commitSha };

    const verdict = await closeTask(stateWithSha256, {
      store: storeFor(stateWithSha256),
      gitHub: gitHubFor(pushEvidence, matchingRemoteState(commitSha)),
    });

    expect(verdict.status).toBe("YES");
  });

  it("returns NO when durable context is missing", async () => {
    const state = { ...closeReadyState(new Date().toISOString()), durableContext: null };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/durable context/i);
  });

  it("returns NO when critical unsaved context remains", async () => {
    const state = { ...closeReadyState(new Date().toISOString()), criticalUnsavedContext: ["unrecorded approval"] };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/unsaved/i);
  });

  it("returns NO when the push did not succeed", async () => {
    const state = closeReadyState(new Date().toISOString());
    const failedPush = {
      ...successfulPush(),
      pushed: false,
      exitCode: 1,
      observedOutput: "rejected by remote",
      failureCategory: "verification-mismatch" as const,
    };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(failedPush, matchingRemoteState(failedPush.localSha)) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/push/i);
  });

  it.each<readonly [string, GitFailureCategory]>([
    ["Authentication failed for 'https://github.com/acme/d-ai.git'", "authentication"],
    ["remote: Permission to acme/d-ai denied", "permission"],
    ["fatal: unable to access remote: Could not resolve host: github.com", "network"],
    ["fatal: repository 'https://github.com/acme/d-ai.git/' not found", "remote-unavailable"],
    ["unexpected push failure", "ambiguous"],
  ])("returns BLOCKED for ambiguous or external push failure: %s", async (observedOutput, failureCategory) => {
    const state = closeReadyState(new Date().toISOString());
    const failedPush = { ...successfulPush(), pushed: false, exitCode: 1, observedOutput, failureCategory };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(failedPush, matchingRemoteState(failedPush.localSha)) });

    expect(verdict.status).toBe("BLOCKED");
  });

  it("returns NO when the remote SHA differs from the pushed SHA", async () => {
    const state = closeReadyState(new Date().toISOString());
    const pushEvidence = successfulPush();
    const remoteState = { ...matchingRemoteState(pushEvidence.localSha), remoteSha: "f".repeat(40), matchesExpectedSha: false };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(pushEvidence, remoteState) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/sha/i);
  });

  it("returns BLOCKED when the remote SHA matches but the adapter match flag is false", async () => {
    const state = closeReadyState(new Date().toISOString());
    const pushEvidence = successfulPush();
    const contradictoryRemoteState = { ...matchingRemoteState(pushEvidence.localSha), matchesExpectedSha: false };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(pushEvidence, contradictoryRemoteState) });

    expect(verdict.status).toBe("BLOCKED");
    expect(verdict.reasons.join(" ")).toMatch(/invalid|conflict|sha/i);
  });

  it("returns NO when a required durable artifact is missing", async () => {
    const state = closeReadyState(new Date().toISOString());
    const durableContext = state.durableContext;
    if (durableContext === null) throw new Error("Expected durable context");
    const missingArtifactState = { ...state, durableContext: { ...durableContext, durablePaths: [], hashes: {} } };
    const verdict = await closeTask(missingArtifactState, {
      store: storeFor(missingArtifactState),
      gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))),
    });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/artifact/i);
  });

  it("returns NO when durable and recovery path sets differ", async () => {
    const state = closeReadyState(new Date().toISOString());
    const recoveryPoint = state.recoveryPoint;
    if (recoveryPoint === null) throw new Error("Expected recovery point");
    const mismatchedState = {
      ...state,
      recoveryPoint: {
        ...recoveryPoint,
        durablePaths: ["recovery-only.json"],
        hashes: { "recovery-only.json": "f".repeat(64) },
      },
    };

    const verdict = await closeTask(mismatchedState, {
      store: storeFor(mismatchedState),
      gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))),
    });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/artifact correspondence/i);
  });

  it("returns NO when durable and recovery hashes differ for the same paths", async () => {
    const state = closeReadyState(new Date().toISOString());
    const recoveryPoint = state.recoveryPoint;
    if (recoveryPoint === null) throw new Error("Expected recovery point");
    const mismatchedState = {
      ...state,
      recoveryPoint: {
        ...recoveryPoint,
        hashes: { ...recoveryPoint.hashes, "artifacts/context.json": "f".repeat(64) },
      },
    };

    const verdict = await closeTask(mismatchedState, {
      store: storeFor(mismatchedState),
      gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))),
    });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/artifact correspondence/i);
  });

  it("returns NO when a required gate is stale", async () => {
    const staleAt = new Date(Date.now() - (6 * 60 * 1_000)).toISOString();
    const state = { ...closeReadyState(new Date().toISOString()), verificationEvidence: evidence(staleAt) };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/stale/i);
  });

  it("returns NO while a handoff is pending", async () => {
    const state = { ...closeReadyState(new Date().toISOString()), handoffState: "pending" as const };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/handoff/i);
  });

  it("returns NO while close approval is pending", async () => {
    const state = { ...closeReadyState(new Date().toISOString()), approvalState: "pending" as const };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(successfulPush(), matchingRemoteState("e".repeat(40))) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/approval/i);
  });

  it("returns NO when local Git evidence reports a dirty worktree", async () => {
    const state = closeReadyState(new Date().toISOString());
    const dirtyPush = {
      ...successfulPush(),
      pushed: false,
      exitCode: 1,
      observedOutput: "Worktree status: M src/close.ts",
      failureCategory: "dirty-worktree" as const,
    };
    const verdict = await closeTask(state, { store: storeFor(state), gitHub: gitHubFor(dirtyPush, matchingRemoteState(dirtyPush.localSha)) });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/worktree/i);
  });

  it("returns BLOCKED when the configured remote cannot be verified", async () => {
    const state = closeReadyState(new Date().toISOString());
    const unavailableGitHub: GitHubAdapter = {
      pushExpectedCommit: async (): Promise<GitPushEvidence> => {
        throw new GitRemoteBlockedError("Configured GitHub remote is unavailable");
      },
      verifyRemoteState: async (): Promise<RemoteState> => matchingRemoteState("e".repeat(40)),
    };

    const verdict = await closeTask(state, { store: storeFor(state), gitHub: unavailableGitHub });

    expect(verdict.status).toBe("BLOCKED");
    expect(verdict.reasons.join(" ")).toMatch(/remote/i);
  });

  it("returns BLOCKED when adapter push evidence does not match the configured remote or ref", async () => {
    const state = closeReadyState(new Date().toISOString());
    const mismatchedPush = { ...successfulPush(), remote: "upstream", ref: "refs/heads/other" };

    const verdict = await closeTask(state, {
      store: storeFor(state),
      gitHub: gitHubFor(mismatchedPush, matchingRemoteState(mismatchedPush.localSha)),
    });

    expect(verdict.status).toBe("BLOCKED");
    expect(verdict.reasons.join(" ")).toMatch(/evidence|remote|ref/i);
  });

  it("returns BLOCKED for malformed adapter commit evidence", async () => {
    const state = closeReadyState(new Date().toISOString());
    const malformedPush = { ...successfulPush(), localSha: "e".repeat(41) };

    const verdict = await closeTask(state, {
      store: storeFor(state),
      gitHub: gitHubFor(malformedPush, matchingRemoteState(malformedPush.localSha)),
    });

    expect(verdict.status).toBe("BLOCKED");
    expect(verdict.reasons.join(" ")).toMatch(/evidence|object id|sha/i);
  });

  it("returns BLOCKED when adapter remote state does not match the configured repository or ref", async () => {
    const state = closeReadyState(new Date().toISOString());
    const pushEvidence = successfulPush();
    const mismatchedRemoteState = {
      ...matchingRemoteState(pushEvidence.localSha),
      repository: "github.com/acme/other",
      ref: "refs/heads/other",
    };

    const verdict = await closeTask(state, {
      store: storeFor(state),
      gitHub: gitHubFor(pushEvidence, mismatchedRemoteState),
    });

    expect(verdict.status).toBe("BLOCKED");
    expect(verdict.reasons.join(" ")).toMatch(/remote state|repository|ref/i);
  });

  it.each([
    ["duplicate commit artifacts", ["artifact:commit:" + "e".repeat(40), "artifact:commit:" + "e".repeat(40)]],
    ["conflicting commit artifacts", ["artifact:commit:" + "e".repeat(40), "artifact:commit:" + "f".repeat(40)]],
    ["malformed commit artifact", ["artifact:commit:" + "e".repeat(41)]],
  ])("returns NO before calling the adapter for %s", async (_label, commitArtifacts) => {
    const state = closeReadyState(new Date().toISOString());
    const withoutCommitArtifact = state.contextManifest.filter((entry) => !entry.startsWith("artifact:commit:"));
    const invalidState = { ...state, contextManifest: [...withoutCommitArtifact, ...commitArtifacts] };

    const verdict = await closeTask(invalidState, { store: storeFor(invalidState), gitHub: unexpectedGitHub() });

    expect(verdict.status).toBe("NO");
    expect(verdict.reasons.join(" ")).toMatch(/commit artifact/i);
  });
});
