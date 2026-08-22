import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TaskOwnershipError } from "../../src/domain/errors.js";
import type { RecoverySnapshot, TaskState } from "../../src/domain/types.js";
import type { TaskOwnershipTransition } from "../../src/state/durable-context-store.js";
import { FILE_DURABLE_CONTEXT_LEASE_MS, FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

function createState(taskId: string, goal: string): TaskState {
  return {
    taskId,
    goal,
    constraints: [],
    environment: "work",
    stage: "bootstrap",
    role: "analyst",
    routingDecision: null,
    selectedCapabilities: [],
    contextManifest: ["workspace:example"],
    handoffState: "none",
    verificationEvidence: [],
    recoveryPoint: null,
    approvalState: "not-required",
    criticalUnsavedContext: [],
    durableContext: null,
  };
}

function createRecoverySnapshot(taskId: string): RecoverySnapshot {
  return {
    head: "0123456789abcdef0123456789abcdef01234567",
    branch: "feat/recovery",
    workspacePath: "C:/workspace",
    status: " M src/example.ts",
    binaryPatch: "diff --git a/src/example.ts b/src/example.ts",
    stateManifest: {
      manifestId: "00000000-0000-4000-8000-000000000001",
      taskId,
      stage: "execute",
      environment: "work",
      role: "implementer",
      durablePaths: ["context.json"],
      hashes: { "context.json": "a".repeat(64) },
      recoveryPointId: null,
      recordedAt: "2026-08-21T00:00:00.000Z",
    },
    verificationResults: [
      {
        evidenceId: "evidence-recovery",
        stage: "verify",
        environment: "work",
        role: "evidence-collector",
        selectedModel: "model",
        command: "npm test",
        observedOutput: "all tests passed",
        exitCode: 0,
        interpretation: "Quality passed",
        passed: true,
        recoveryPointId: null,
        recordedAt: "2026-08-21T00:00:00.000Z",
      },
    ],
    durableArtifacts: { "context.json": "a".repeat(64) },
  };
}

async function createStoreRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "d-ai-context-store-"));
}

describe("FileDurableContextStore", () => {
  it("round-trips a validated state with durable content hashes", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-round-trip", "Preserve durable context");

    try {
      const manifest = await store.save(state);
      const recovered = await store.load(state.taskId);

      expect(recovered?.goal).toBe(state.goal);
      expect(recovered?.durableContext).toEqual(manifest);
      expect(Object.keys(manifest.hashes)).toHaveLength(7);
      expect(Object.keys(manifest.hashes).sort()).toEqual([...manifest.durablePaths].sort());
      expect(Object.values(manifest.hashes)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
      );
      const contextPath = manifest.durablePaths[0];
      if (contextPath === undefined) {
        throw new Error("Expected a durable context path");
      }
      const content = await readFile(contextPath, "utf8");
      expect(manifest.hashes[contextPath]).toBe(createHash("sha256").update(content, "utf8").digest("hex"));
      const generationRoot = join(rootPath, state.taskId, "generations", manifest.manifestId);
      expect((await readdir(generationRoot)).sort()).toEqual([
        "approval.json",
        "context.json",
        "evidence.json",
        "handoff.json",
        "manifest.json",
        "recovery.json",
        "state.json",
      ]);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("reloads the manifest-addressed generation and rejects generation corruption", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-generation-corruption", "Verify immutable generation reload");

    try {
      const manifest = await store.save(state);
      const generationStatePath = join(rootPath, state.taskId, "generations", manifest.manifestId, "state.json");
      const generationState = JSON.parse(await readFile(generationStatePath, "utf8")) as { goal: string };
      generationState.goal = "corrupted";
      await writeFile(generationStatePath, `${JSON.stringify(generationState, null, 2)}\n`, "utf8");

      await expect(store.load(state.taskId)).rejects.toThrow(/generation.*state\.json|content hash mismatch/i);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects recovery when a hashed companion record is changed", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-tampered-companion", "Detect durable corruption");

    try {
      const manifest = await store.save(state);
      const contextPath = join(rootPath, state.taskId, "context.json");
      const expectedHash = manifest.hashes[contextPath];
      if (expectedHash === undefined) {
        throw new Error("Expected a context hash");
      }
      await writeFile(contextPath, '{\n  "goal": "changed",\n  "constraints": [],\n  "contextManifest": []\n}\n', "utf8");

      await expect(store.load(state.taskId)).rejects.toThrow(
        new RegExp(`task-tampered-companion.*${contextPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*${expectedHash}.*[a-f0-9]{64}`),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects recovery when the canonical state record is changed", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-tampered-state", "Protect canonical state");

    try {
      const manifest = await store.save(state);
      const statePath = join(rootPath, state.taskId, "state.json");
      const expectedHash = manifest.hashes[statePath];
      if (expectedHash === undefined) {
        throw new Error("Expected a state hash");
      }
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as { goal: string };
      persisted.goal = "changed";
      await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

      await expect(store.load(state.taskId)).rejects.toThrow(
        new RegExp(`task-tampered-state.*${statePath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*${expectedHash}.*[a-f0-9]{64}`),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects recovery when the canonical manifest record is changed", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-tampered-manifest", "Protect canonical manifest");

    try {
      const manifest = await store.save(state);
      const manifestPath = join(rootPath, state.taskId, "manifest.json");
      const expectedHash = manifest.hashes[manifestPath];
      if (expectedHash === undefined) {
        throw new Error("Expected a manifest hash");
      }
      const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as { recordedAt: string };
      persisted.recordedAt = "2026-01-01T00:00:00.000Z";
      await writeFile(manifestPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

      await expect(store.load(state.taskId)).rejects.toThrow(
        new RegExp(`task-tampered-manifest.*${manifestPath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*${expectedHash}.*[a-f0-9]{64}`),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects recovery when a required companion record is missing", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-missing-companion", "Require durable records");

    try {
      const manifest = await store.save(state);
      const evidencePath = join(rootPath, state.taskId, "evidence.json");
      const expectedHash = manifest.hashes[evidencePath];
      if (expectedHash === undefined) {
        throw new Error("Expected an evidence hash");
      }
      await rm(evidencePath);

      await expect(store.load(state.taskId)).rejects.toThrow(
        new RegExp(`task-missing-companion.*${evidencePath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*${expectedHash}.*missing`),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects recovery when the state commit marker is missing but snapshot artifacts remain", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-missing-state", "Require the durable state commit marker");
    const statePath = join(rootPath, state.taskId, "state.json");

    try {
      await store.save(state);
      await rm(statePath);

      await expect(store.load(state.taskId)).rejects.toThrow(
        new RegExp(`task-missing-state.*${statePath.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`),
      );
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each(["manifest.json", "recovery.json"] as const)("rejects recovery when the required %s artifact is missing", async (artifact) => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState(`task-missing-${artifact.replace(".json", "")}`, `Require ${artifact}`);
    const artifactPath = join(rootPath, state.taskId, artifact);

    try {
      await store.save(state);
      await rm(artifactPath);

      await expect(store.load(state.taskId)).rejects.toThrow(/required durable artifact|missing|integrity/i);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid persisted state during recovery", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const statePath = join(rootPath, "task-invalid", "state.json");

    try {
      await store.save(createState("task-invalid", "Reject invalid state"));
      await writeFile(statePath, "{\"taskId\":\"task-invalid\"}", { encoding: "utf8" });

      await expect(store.load("task-invalid")).rejects.toThrow("Invalid task state");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects credential-like fields before writing a target path", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = {
      ...createState("task-secret", "Do not store credentials"),
      apiToken: "not-allowed",
    };

    try {
      await expect(store.save(state as TaskState)).rejects.toThrow(/apiToken.*target path/i);
      await expect(store.load("task-secret")).resolves.toBeNull();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it.each(["github_pat_123456789012345678901234567890", "ghp_123456789012345678901234567890", "sk-123456789012345678901234567890", "-----BEGIN PRIVATE KEY-----"]) (
    "rejects secret-shaped values before writing %s",
    async (secret) => {
      const rootPath = await createStoreRoot();
      const store = new FileDurableContextStore(rootPath);
      try {
        await expect(store.save({ ...createState(`task-secret-${secret.slice(0, 3)}`, secret) })).rejects.toThrow(/secret-like|credential/i);
        await expect(store.load(`task-secret-${secret.slice(0, 3)}`)).resolves.toBeNull();
      } finally {
        await rm(rootPath, { recursive: true, force: true });
      }
    },
  );

  it("atomically replaces a prior durable snapshot", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const first = createState("task-replace", "Initial goal");
    const second = createState("task-replace", "Replacement goal");

    try {
      await store.save(first);
      await store.save(second);

      const statePath = join(rootPath, "task-replace", "state.json");
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as { readonly goal: string };
      expect(persisted.goal).toBe(second.goal);
      await expect(store.load(second.taskId)).resolves.toMatchObject({ goal: second.goal });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("records and clears critical unsaved context through the durable snapshot", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-critical-context", "Do not lose this work");

    try {
      await store.save(state);
      await store.withTaskOwnership(state.taskId, state.environment, async (lease) => {
        await store.recordCriticalUnsavedContext(state.taskId, ["uncommitted migration"], lease);
        await expect(store.load(state.taskId)).resolves.toMatchObject({
          criticalUnsavedContext: ["uncommitted migration"],
        });

        await store.clearCriticalUnsavedContext(state.taskId, lease);
        await expect(store.load(state.taskId)).resolves.toMatchObject({ criticalUnsavedContext: [] });
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("blocks a second runtime while a task ownership lease is active", async () => {
    const rootPath = await createStoreRoot();
    const firstStore = new FileDurableContextStore(rootPath);
    const secondStore = new FileDurableContextStore(rootPath);
    let releaseFirst: () => void = () => {};
    let markFirstActive: () => void = () => {};
    const firstActive = new Promise<void>((resolve) => { markFirstActive = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });

    try {
      const first = firstStore.withTaskOwnership("task-contention", "codex", async () => {
        markFirstActive();
        await firstRelease;
      });
      await firstActive;

      await expect(secondStore.withTaskOwnership("task-contention", "codex", async () => {})).rejects.toThrow(TaskOwnershipError);

      releaseFirst();
      await first;
      await expect(secondStore.withTaskOwnership("task-contention", "codex", async () => {})).resolves.toBeUndefined();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("records an explicit ownership transfer before releasing a handoff command", async () => {
    const rootPath = await createStoreRoot();
    const sourceStore = new FileDurableContextStore(rootPath);
    const targetStore = new FileDurableContextStore(rootPath);
    const state = createState("task-transfer", "Transfer durable ownership");

    try {
      await sourceStore.save({ ...state, environment: "codex" });
      await sourceStore.withTaskOwnership("task-transfer", "codex", async (lease, transfer) => {
        const targetLease = await transfer("work");
        await expect(sourceStore.save({ ...state, environment: "work", durableContext: null }, lease)).rejects.toThrow(TaskOwnershipError);
        await expect(sourceStore.save({ ...state, environment: "work", durableContext: null }, targetLease)).resolves.toMatchObject({
          environment: "work",
        });
      });

      const transfer = JSON.parse(await readFile(join(rootPath, "task-transfer", "ownership", "1", "transfer.json"), "utf8")) as {
        readonly sourceEnvironment: string;
        readonly targetEnvironment: string;
      };
      expect(transfer).toMatchObject({ sourceEnvironment: "codex", targetEnvironment: "work" });
      await expect(targetStore.withTaskOwnership("task-transfer", "work", async () => {})).resolves.toBeUndefined();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("does not let a stale release clear a successor ownership generation", async () => {
    const rootPath = await createStoreRoot();
    const firstStore = new FileDurableContextStore(rootPath);
    const secondStore = new FileDurableContextStore(rootPath);
    const thirdStore = new FileDurableContextStore(rootPath);
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    let markFirstActive: () => void = () => {};
    let markSecondActive: () => void = () => {};
    const firstActive = new Promise<void>((resolve) => { markFirstActive = resolve; });
    const secondActive = new Promise<void>((resolve) => { markSecondActive = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondRelease = new Promise<void>((resolve) => { releaseSecond = resolve; });

    try {
      const first = firstStore.withTaskOwnership("task-stale-release", "codex", async () => {
        markFirstActive();
        await firstRelease;
      });
      await firstActive;
      const expiredAt = new Date(Date.now() - 30_001);
      await utimes(join(rootPath, "task-stale-release", "ownership", "1", "lease"), expiredAt, expiredAt);

      const second = secondStore.withTaskOwnership("task-stale-release", "work", async () => {
        markSecondActive();
        await secondRelease;
      });
      await secondActive;
      releaseFirst();
      await expect(first).rejects.toThrow(TaskOwnershipError);

      await expect(thirdStore.withTaskOwnership("task-stale-release", "work", async () => {})).rejects.toThrow(TaskOwnershipError);

      releaseSecond();
      await second;
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects a stale owner write after a successor acquires the lease", async () => {
    const rootPath = await createStoreRoot();
    const firstStore = new FileDurableContextStore(rootPath);
    const secondStore = new FileDurableContextStore(rootPath);
    const state = createState("task-stale-write", "Original goal");
    let releaseFirst: () => void = () => {};
    let releaseSecond: () => void = () => {};
    let markFirstActive: () => void = () => {};
    let markSecondActive: () => void = () => {};
    const firstActive = new Promise<void>((resolve) => { markFirstActive = resolve; });
    const secondActive = new Promise<void>((resolve) => { markSecondActive = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondRelease = new Promise<void>((resolve) => { releaseSecond = resolve; });
    try {
      await firstStore.save(state);
      const first = firstStore.withTaskOwnership("task-stale-write", "work", async (lease) => {
        markFirstActive();
        await firstRelease;
        await expect(firstStore.save({ ...state, goal: "Stale goal", durableContext: null }, lease)).rejects.toThrow(TaskOwnershipError);
      });
      await firstActive;
      const expiredAt = new Date(Date.now() - 30_001);
      await utimes(join(rootPath, "task-stale-write", "ownership", "1", "lease"), expiredAt, expiredAt);

      const second = secondStore.withTaskOwnership("task-stale-write", "work", async (lease) => {
        await secondStore.save({ ...state, goal: "Successor goal", durableContext: null }, lease);
        markSecondActive();
        await secondRelease;
      });
      await secondActive;
      releaseFirst();
      await expect(first).rejects.toThrow(TaskOwnershipError);

      await expect(secondStore.load("task-stale-write")).resolves.toMatchObject({ goal: "Successor goal" });

      releaseSecond();
      await second;
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("permits only an ownership-authorized transition to its target environment", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-environment-fence", "Keep environment ownership aligned");

    try {
      await store.save(state);
      await store.withTaskOwnership(state.taskId, "work", async (lease, _transfer, _assertOwnership, authorizeTransition) => {
        await expect(store.save({ ...state, environment: "codex", durableContext: null }, lease)).rejects.toThrow(TaskOwnershipError);
        const forgedTransition = { lease, targetEnvironment: "codex" } as unknown as TaskOwnershipTransition;
        await expect(store.save({ ...state, environment: "codex", durableContext: null }, forgedTransition)).rejects.toThrow(TaskOwnershipError);
        const transition = authorizeTransition("codex");
        if (!("targetEnvironment" in transition)) throw new Error("Expected a cross-environment transition authorization");
        const staleTransition = { ...transition, lease: { ...transition.lease, generation: transition.lease.generation + 1n } };
        await expect(store.save({ ...state, environment: "codex", durableContext: null }, staleTransition)).rejects.toThrow(TaskOwnershipError);
        await expect(store.save({ ...state, environment: "codex", durableContext: null }, transition)).resolves.toMatchObject({
          environment: "codex",
        });
        await expect(store.save({ ...state, environment: "chat", durableContext: null }, transition)).rejects.toThrow(TaskOwnershipError);
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects close-candidate and critical-context writes from a mismatched lease generation", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-lease-bearing-writes", "Fence every auxiliary write");

    try {
      await store.save(state);
      const persisted = await store.load(state.taskId);
      if (persisted?.durableContext === null || persisted?.durableContext === undefined) throw new Error("Expected persisted durable context");
      await store.withTaskOwnership(state.taskId, "work", async (lease) => {
        const staleLease = { ...lease, generation: lease.generation + 1n };
        const candidate = {
          taskId: state.taskId,
          durableContext: persisted.durableContext,
          contextManifest: persisted.contextManifest,
          repositoryPath: "C:/workspace",
          remote: "origin",
          ref: "refs/heads/main",
          commitSha: "a".repeat(40),
          criticalUnsavedContext: [],
          recordedAt: "2026-08-22T00:00:00.000Z",
        };
        const saveCloseCandidate = store.saveCloseCandidate.bind(store) as unknown as (value: typeof candidate, owner: typeof staleLease) => Promise<void>;
        const recordCriticalUnsavedContext = store.recordCriticalUnsavedContext.bind(store) as unknown as (taskId: string, items: readonly string[], owner: typeof staleLease) => Promise<void>;
        const clearCriticalUnsavedContext = store.clearCriticalUnsavedContext.bind(store) as unknown as (taskId: string, owner: typeof staleLease) => Promise<void>;

        await expect(saveCloseCandidate(candidate, staleLease)).rejects.toThrow(TaskOwnershipError);
        await expect(recordCriticalUnsavedContext(state.taskId, ["uncommitted migration"], staleLease)).rejects.toThrow(TaskOwnershipError);
        await expect(clearCriticalUnsavedContext(state.taskId, staleLease)).rejects.toThrow(TaskOwnershipError);
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("round-trips a validated debug session with durable task state", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state: TaskState = {
      ...createState("task-debug-session", "Persist debugging progress"),
      debugSession: {
        phase: "hypothesize",
        originalFailure: "build exits 1",
        hypothesis: "manifest mismatch",
        preservedRecoveryPointId: "recovery-1",
      },
    };

    try {
      await store.save(state);
      const recovered = await store.load(state.taskId);

      expect(recovered?.debugSession).toEqual(state.debugSession);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("round-trips and integrity-protects a recovery snapshot in state and recovery records", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const snapshot = createRecoverySnapshot("task-recovery-snapshot");
    const state: TaskState = { ...createState("task-recovery-snapshot", "Persist recovery snapshot"), recoverySnapshot: snapshot };

    try {
      const manifest = await store.save(state);
      const recovered = await store.load(state.taskId);
      expect(recovered?.recoverySnapshot).toEqual(snapshot);

      const recoveryPath = join(rootPath, state.taskId, "recovery.json");
      const recoveryContent = await readFile(recoveryPath, "utf8");
      expect(JSON.parse(recoveryContent)).toMatchObject({ recoverySnapshot: snapshot });

      const statePath = join(rootPath, state.taskId, "state.json");
      const persistedState = JSON.parse(await readFile(statePath, "utf8")) as { recoverySnapshot: { status: string } };
      persistedState.recoverySnapshot.status = "tampered";
      await writeFile(statePath, `${JSON.stringify(persistedState, null, 2)}\n`, "utf8");
      await expect(store.load(state.taskId)).rejects.toThrow(/canonical state hash mismatch|content hash mismatch/i);
      expect(manifest.hashes[statePath]).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects an unknown recovery snapshot field before persistence", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const snapshot = createRecoverySnapshot("task-invalid-recovery-snapshot");
    const state = {
      ...createState("task-invalid-recovery-snapshot", "Reject invalid recovery snapshot"),
      recoverySnapshot: { ...snapshot, unexpected: true },
    } as TaskState;

    try {
      await expect(store.save(state)).rejects.toThrow(/recoverySnapshot.*unrecognized|unrecognized.*recoverySnapshot/i);
      await expect(store.load(state.taskId)).resolves.toBeNull();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("round-trips a rollback audit with the recovery record", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const audit = {
      archiveId: "stash@{0}",
      patchDigest: "b".repeat(64),
      actions: [{ command: "git", arguments: ["revert", "--no-edit"], stdout: "reverted", stderr: "", exitCode: 0 }],
      verification: { passed: true, observedOutput: "tree verified", reason: "Recovery tree matches" },
      recordedAt: "2026-08-21T00:00:00.000Z",
    } as const;
    const state: TaskState = { ...createState("task-rollback-audit", "Persist rollback audit"), rollbackAudit: audit };

    try {
      await store.save(state);
      await expect(store.load(state.taskId)).resolves.toMatchObject({ rollbackAudit: audit });
      await expect(readFile(join(rootPath, state.taskId, "recovery.json"), "utf8")).resolves.toContain("stash@{0}");
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("publishes owned saves through an immutable generation pointer", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-active-pointer", "Publish through a fenced pointer");

    try {
      await store.withTaskOwnership(state.taskId, "work", async (lease) => {
        await store.save(state, lease);
      });

      const activeRoot = join(rootPath, state.taskId, "active");
      const activeEntries = await readdir(activeRoot);
      expect(activeEntries).toHaveLength(1);
      expect(activeEntries[0]).toBe("00000000000000000001.json");
      await expect(store.load(state.taskId)).resolves.toMatchObject({ goal: state.goal });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("loads the selected generation when a newer top-level companion mirror is unpublished", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const firstState = createState("task-unpublished-companion", "Published generation");
    const secondState = { ...firstState, goal: "Unpublished generation" };

    try {
      await store.withTaskOwnership(firstState.taskId, firstState.environment, async (lease) => {
        await store.save(firstState, lease);
        await store.save(secondState);
      });

      await expect(store.load(firstState.taskId)).resolves.toMatchObject({ goal: firstState.goal });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("fences a late lower-generation pointer behind the successor pointer", async () => {
    const rootPath = await createStoreRoot();
    const firstStore = new FileDurableContextStore(rootPath);
    const secondStore = new FileDurableContextStore(rootPath);
    const firstState = createState("task-pointer-fencing", "First generation");
    const secondState = { ...firstState, goal: "Successor generation" };

    try {
      await firstStore.withTaskOwnership(firstState.taskId, firstState.environment, async (lease) => {
        await firstStore.save(firstState, lease);
      });
      await secondStore.withTaskOwnership(secondState.taskId, "work", async (lease) => {
        await secondStore.save(secondState, lease);
      });

      const activeRoot = join(rootPath, firstState.taskId, "active");
      const activeEntries = (await readdir(activeRoot)).sort();
      expect(activeEntries).toHaveLength(2);
      const stalePointerPath = join(activeRoot, activeEntries[0]!);
      const stalePointer = JSON.parse(await readFile(stalePointerPath, "utf8")) as { readonly manifestId: string; readonly ownershipGeneration: string };
      await rm(stalePointerPath);
      await writeFile(stalePointerPath, `${JSON.stringify(stalePointer)}\n`, "utf8");

      await expect(secondStore.load(firstState.taskId)).resolves.toMatchObject({ goal: secondState.goal });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("propagates a heartbeat renewal failure after the operation finishes", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-heartbeat-failure", "Propagate heartbeat failure");
    await store.save(state);
    try {
      await expect(store.withTaskOwnership("task-heartbeat-failure", "work", async () => {
        const leasePath = join(rootPath, "task-heartbeat-failure", "ownership", "1", "lease");
        const leaseToken = await readFile(leasePath, "utf8");
        await rm(leasePath);
        await new Promise<void>((resolve) => setTimeout(resolve, FILE_DURABLE_CONTEXT_LEASE_MS / 3 + 250));
        await writeFile(leasePath, leaseToken, "utf8");
        return "operation-result";
      })).rejects.toThrow(TaskOwnershipError);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  }, 15_000);
});
import { createHash } from "node:crypto";
