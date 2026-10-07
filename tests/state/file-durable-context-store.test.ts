import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InvalidTaskStateError, TaskOwnershipError } from "../../src/domain/errors.js";
import type { RecoverySnapshot, TaskCharter, TaskState } from "../../src/domain/types.js";
import { FileHandoffPersistence, PersistentHandoffService } from "../../src/handoff/handoff-service.js";
import type { TaskOwnershipTransition } from "../../src/state/durable-context-store.js";
import { FILE_DURABLE_CONTEXT_LEASE_MS, FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import { taskCharterContentDigest, taskCharterTaskId } from "../../src/state/task-charter.js";

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

const initialProjectIdentity = "remote-repository:github.com/example/initial-store-fixture";

function createRepositoryState(taskId: string, goal: string, stage: TaskState["stage"] = "bootstrap"): TaskState {
  return {
    ...createState(taskId, goal),
    environment: "codex",
    stage,
    contextManifest: [
      `identity:workspace:C:/synthetic/workspace:${"1".repeat(64)}`,
      `identity:repository:C:/synthetic/repository:${"2".repeat(64)}`,
      initialProjectIdentity,
    ],
  };
}

function approvedCharter(projectIdentity: string, objective: string): TaskCharter {
  const content = {
    schemaVersion: 1 as const,
    charterId: "initial-store-fixture",
    charterVersion: "1",
    projectIdentity,
    objective,
    ownedScope: ["one synthetic project task"],
    excludedScope: ["other synthetic projects"],
    completionCriteria: ["the task is durably stored"],
    terminationCondition: "Stop after the store lifecycle check.",
    initialNextAction: "Inspect the synthetic project.",
  };
  return {
    ...content,
    approval: {
      confirmation: "I_APPROVE_THIS_TASK_CHARTER",
      approvedBy: "synthetic-store-operator",
      approvedAt: "2026-10-07T00:00:00.000Z",
      approvalReference: "synthetic approval",
      projectIdentity,
      approvedCharterDigest: taskCharterContentDigest(content),
    },
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

async function latestOwnershipGenerationPath(rootPath: string, taskId: string): Promise<string> {
  const entries = (await readdir(join(rootPath, taskId, "ownership"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => Number(BigInt(right) - BigInt(left)));
  const generation = entries[0];
  if (generation === undefined) throw new Error(`No ownership generation exists for ${taskId}`);
  return join(rootPath, taskId, "ownership", generation);
}

describe("FileDurableContextStore", () => {
  it("admits one ordinary initial project task and does not poison a later charter successor", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const initial = createRepositoryState(`task-${"a".repeat(24)}`, "establish the synthetic project");
    try {
      const manifest = await store.createInitialProjectTaskIfEmpty!(initial, initialProjectIdentity);
      expect(manifest?.taskId).toBe(initial.taskId);
      const generationsPath = join(rootPath, initial.taskId, "generations");
      const generations = (await readdir(generationsPath, { withFileTypes: true })).filter((entry) => entry.isDirectory());
      expect(generations.length).toBeGreaterThan(0);
      for (const generation of generations) {
        const generationManifest = await store.loadGenerationManifest!(initial.taskId, generation.name);
        expect(generationManifest.manifestId).toBe(generation.name);
        expect(generationManifest.durablePaths).toContain(join(rootPath, initial.taskId, "state.json"));
      }
      expect(await store.createInitialProjectTaskIfEmpty!(initial, initialProjectIdentity)).toEqual(manifest);
      expect(await store.hasProjectSuccessorConflict(initialProjectIdentity)).toBe(false);
      await store.withTaskOwnership!(initial.taskId, "codex", async (_lease, transfer) => {
        const targetLease = await transfer("work");
        await store.save({ ...initial, environment: "work", durableContext: null }, targetLease);
      });
      const transferred = await store.load(initial.taskId);
      if (transferred === null) throw new Error("Ordinary task disappeared after authorized ownership transfer");
      expect(await store.hasProjectSuccessorConflict(initialProjectIdentity)).toBe(false);
      const frozenInitial = { ...transferred, routingDisposition: "LEGACY_FROZEN" as const, durableContext: null };
      await store.withTaskOwnership!(initial.taskId, "work", async (lease) => { await store.save(frozenInitial, lease); });

      const charter = approvedCharter(initialProjectIdentity, "approved successor after legacy freeze");
      const digest = taskCharterContentDigest(charter);
      const successor = {
        ...createRepositoryState(taskCharterTaskId(initialProjectIdentity, digest), charter.objective),
        routingDisposition: "ROUTABLE" as const,
        taskCharter: charter,
        taskCharterConfirmation: {
          confirmationId: "00000000-0000-4000-8000-000000000001",
          confirmedAt: "2026-10-07T00:00:00.000Z",
          projectIdentity: initialProjectIdentity,
          confirmedCharterDigest: digest,
          channel: "explicit-task-charter-digest" as const,
        },
      };
      await expect(store.createSuccessorIfAbsent!(successor, initialProjectIdentity, digest)).resolves.toMatchObject({ taskId: successor.taskId });
      expect(await store.hasProjectSuccessorConflict(initialProjectIdentity)).toBe(false);
    } finally {
      await rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("does not reclassify a closed same-id charter task as a first registration", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const charter = approvedCharter(initialProjectIdentity, "closed initial charter task");
    const digest = taskCharterContentDigest(charter);
    const proposed: TaskState = {
      ...createRepositoryState(taskCharterTaskId(initialProjectIdentity, digest), charter.objective),
      routingDisposition: "ROUTABLE",
      taskCharter: charter,
      taskCharterConfirmation: {
        confirmationId: "00000000-0000-4000-8000-000000000003",
        confirmedAt: "2026-10-07T00:00:00.000Z",
        projectIdentity: initialProjectIdentity,
        confirmedCharterDigest: digest,
        channel: "explicit-task-charter-digest",
      },
    };
    try {
      await store.createInitialProjectTaskIfEmpty!(proposed, initialProjectIdentity);
      const initial = await store.load(proposed.taskId);
      if (initial === null) throw new Error("Initial charter task was not persisted");
      await store.withTaskOwnership!(initial.taskId, initial.environment, async (lease) => {
        await store.save({ ...initial, stage: "close", durableContext: null }, lease);
      });
      const closedBytes = await readFile(join(rootPath, proposed.taskId, "state.json"));

      await expect(store.createInitialProjectTaskIfEmpty!(proposed, initialProjectIdentity)).resolves.toBeNull();
      expect(await readFile(join(rootPath, proposed.taskId, "state.json"))).toEqual(closedBytes);
    } finally {
      await rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("serializes competing workspace ownership and publishes at most one initial task", async () => {
    const rootPath = await createStoreRoot();
    let reachedStaging!: () => void;
    let releaseStaging!: () => void;
    const stagingReady = new Promise<void>((resolvePromise) => { reachedStaging = resolvePromise; });
    const continueFirst = new Promise<void>((resolvePromise) => { releaseStaging = resolvePromise; });
    const first = new FileDurableContextStore(rootPath, {
      afterInitialCompanionsWritten: async () => { reachedStaging(); await continueFirst; },
    });
    const second = new FileDurableContextStore(rootPath);
    const firstState = createRepositoryState(`task-${"f".repeat(24)}`, "workspace A initial task");
    const secondState: TaskState = {
      ...createRepositoryState(`task-${"9".repeat(24)}`, "workspace B initial task"),
      contextManifest: createRepositoryState(`task-${"9".repeat(24)}`, "workspace B initial task").contextManifest.map((entry) =>
        entry.startsWith("identity:workspace:") ? `identity:workspace:C:/other-workspace:${"3".repeat(64)}` : entry),
    };
    try {
      const firstAttempt = first.createInitialProjectTaskIfEmpty!(firstState, initialProjectIdentity);
      await stagingReady;
      await expect(second.createInitialProjectTaskIfEmpty!(secondState, initialProjectIdentity))
        .rejects.toThrow(TaskOwnershipError);
      releaseStaging();
      const firstManifest = await firstAttempt;
      expect(await first.load(firstState.taskId)).toMatchObject({ taskId: firstState.taskId, durableContext: firstManifest });
      await expect(second.createInitialProjectTaskIfEmpty!(secondState, initialProjectIdentity))
        .rejects.toThrow(/different workspace or environment/u);
      expect((await readdir(rootPath)).filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry))).toEqual([firstState.taskId]);
    } finally {
      releaseStaging();
      await rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it.each([
    { label: "same charter and task id with a different environment", variant: "environment" },
    { label: "same charter and task id with a different workspace", variant: "workspace" },
    { label: "different charter content with the same owner", variant: "charter" },
  ] as const)("fences $label during initial registration", async ({ variant }) => {
    const rootPath = await createStoreRoot();
    let reachedStaging!: () => void;
    let releaseStaging!: () => void;
    const stagingReady = new Promise<void>((resolvePromise) => { reachedStaging = resolvePromise; });
    const continueFirst = new Promise<void>((resolvePromise) => { releaseStaging = resolvePromise; });
    const firstStore = new FileDurableContextStore(rootPath, {
      afterInitialCompanionsWritten: async () => { reachedStaging(); await continueFirst; },
    });
    const secondStore = new FileDurableContextStore(rootPath);
    const firstCharter = approvedCharter(initialProjectIdentity, "same approved initial charter");
    const competingCharter = variant === "charter"
      ? approvedCharter(initialProjectIdentity, "different competing charter content")
      : firstCharter;
    const toState = (taskCharter: TaskCharter, environment: TaskState["environment"], workspacePath: string): TaskState => {
      const digest = taskCharterContentDigest(taskCharter);
      const taskId = taskCharterTaskId(initialProjectIdentity, digest);
      const base = createRepositoryState(taskId, taskCharter.objective);
      return {
        ...base,
        environment,
        contextManifest: base.contextManifest.map((entry) => entry.startsWith("identity:workspace:")
          ? `identity:workspace:${workspacePath}:${"3".repeat(64)}`
          : entry),
        routingDisposition: "ROUTABLE",
        taskCharter,
        taskCharterConfirmation: {
          confirmationId: "00000000-0000-4000-8000-000000000010",
          confirmedAt: "2026-10-07T00:00:00.000Z",
          projectIdentity: initialProjectIdentity,
          confirmedCharterDigest: digest,
          channel: "explicit-task-charter-digest",
        },
      };
    };
    const firstState = toState(firstCharter, "codex", "C:/synthetic/workspace");
    const secondState = variant === "environment"
      ? toState(firstCharter, "work", "C:/synthetic/workspace")
      : variant === "workspace"
        ? toState(firstCharter, "codex", "C:/other-synthetic/workspace")
        : toState(competingCharter, "codex", "C:/synthetic/workspace");
    try {
      if (variant !== "charter") expect(secondState.taskId).toBe(firstState.taskId);
      else expect(secondState.taskId).not.toBe(firstState.taskId);

      const firstAttempt = firstStore.createInitialProjectTaskIfEmpty!(firstState, initialProjectIdentity);
      await stagingReady;
      await expect(secondStore.createInitialProjectTaskIfEmpty!(secondState, initialProjectIdentity))
        .rejects.toThrow(TaskOwnershipError);
      releaseStaging();
      const firstManifest = await firstAttempt;
      expect(await firstStore.load(firstState.taskId)).toMatchObject({ taskId: firstState.taskId, durableContext: firstManifest });
      const secondError = variant === "charter"
        ? /different approved charter/u
        : /different workspace or environment/u;
      await expect(secondStore.createInitialProjectTaskIfEmpty!(secondState, initialProjectIdentity))
        .rejects.toThrow(secondError);
      expect((await readdir(rootPath)).filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry))).toEqual([firstState.taskId]);
    } finally {
      releaseStaging();
      await rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("distinguishes active admission from another project's contender-only history", async () => {
    const rootPath = await createStoreRoot();
    const otherProjectIdentity = "remote-repository:github.com/example/other-initial-store-fixture";
    let registered!: () => void;
    let release!: () => void;
    const contenderReady = new Promise<void>((resolvePromise) => { registered = resolvePromise; });
    const continueFirst = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const firstStore = new FileDurableContextStore(rootPath, {
      afterProjectContenderRegistered: async () => {
        registered();
        await continueFirst;
        throw new Error("synthetic interrupted admission after contender registration");
      },
    });
    const otherStore = new FileDurableContextStore(rootPath);
    const firstState = createRepositoryState(`task-${"e".repeat(24)}`, "first project contender");
    const otherState = {
      ...createRepositoryState(`task-${"1".repeat(24)}`, "other project ordinary task"),
      contextManifest: createRepositoryState(`task-${"1".repeat(24)}`, "other project ordinary task").contextManifest
        .map((entry) => entry === initialProjectIdentity ? otherProjectIdentity : entry),
    };
    try {
      const firstAttempt = firstStore.createInitialProjectTaskIfEmpty!(firstState, initialProjectIdentity);
      await contenderReady;

      await expect(otherStore.createInitialProjectTaskIfEmpty!(otherState, otherProjectIdentity))
        .rejects.toThrow(/another durable task is being admitted/iu);
      expect(await otherStore.load(otherState.taskId)).toBeNull();

      release();
      await expect(firstAttempt).rejects.toThrow(/synthetic interrupted admission/u);
      await expect(otherStore.createInitialProjectTaskIfEmpty!(otherState, otherProjectIdentity))
        .rejects.toThrow(/without verified durable task history/u);
      expect((await readdir(rootPath)).filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry))).toEqual([]);
    } finally {
      release();
      await rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("never treats closed, in-progress, corrupt, or unknown durable-root history as empty", async () => {
    const closedRoot = await createStoreRoot();
    const closedStore = new FileDurableContextStore(closedRoot);
    const closed = createRepositoryState(`task-${"b".repeat(24)}`, "closed synthetic project", "close");
    const candidate = createRepositoryState(`task-${"c".repeat(24)}`, "new synthetic project intent");
    const rootsToCheck = [closedRoot, await createStoreRoot(), await createStoreRoot(), await createStoreRoot()];
    try {
      await closedStore.save(closed);
      await mkdir(join(rootsToCheck[1]!, ".successor-staging-in-progress"), { recursive: true });
      await mkdir(join(rootsToCheck[2]!, `task-${"d".repeat(24)}`), { recursive: true });
      await writeFile(join(rootsToCheck[2]!, `task-${"d".repeat(24)}`, "state.json"), "{corrupt", "utf8");
      await writeFile(join(rootsToCheck[3]!, "unknown-history.bin"), "synthetic", "utf8");

      await expect(closedStore.createInitialProjectTaskIfEmpty!(candidate, initialProjectIdentity)).resolves.toBeNull();
      await expect(new FileDurableContextStore(rootsToCheck[1]!).createInitialProjectTaskIfEmpty!(candidate, initialProjectIdentity)).rejects.toThrow(/in progress/u);
      await expect(new FileDurableContextStore(rootsToCheck[2]!).createInitialProjectTaskIfEmpty!(candidate, initialProjectIdentity)).rejects.toThrow(/missing|invalid|corrupt|manifest/u);
      await expect(new FileDurableContextStore(rootsToCheck[3]!).createInitialProjectTaskIfEmpty!(candidate, initialProjectIdentity)).rejects.toThrow(/Unknown durable task root entry/u);
      expect(await closedStore.load(candidate.taskId)).toBeNull();
    } finally {
      await Promise.all(rootsToCheck.map((rootPath) => rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
    }
  });

  it("rejects initial admission before mutating a root with valid handoff history", async () => {
    const rootPath = await createStoreRoot();
    const handoffFixtureRoot = await createStoreRoot();
    const handoffPath = join(handoffFixtureRoot, "handoffs.json");
    const handoffService = new PersistentHandoffService(new FileHandoffPersistence(handoffPath));
    const priorHandoffState = {
      ...createRepositoryState(`task-${"a".repeat(24)}`, "synthetic prior handoff"),
      stage: "execute" as const,
      role: "implementer" as const,
      approvalState: "approved" as const,
    };
    try {
      await handoffService.create({ state: priorHandoffState, targetEnvironment: "work" });
      const handoffBytes = await readFile(join(handoffPath + ".lock", "1", "committed", "snapshot.json"));
      const handoffDocument = JSON.parse(handoffBytes.toString("utf8")) as { records?: readonly unknown[] };
      expect(handoffDocument.records).toHaveLength(1);
      const historyPath = join(rootPath, "handoffs.json");
      await writeFile(historyPath, handoffBytes);
      const beforeBytes = await readFile(historyPath);
      const beforeEntries = await readdir(rootPath);
      const charter = approvedCharter(initialProjectIdentity, "approved charter rejected beside handoff history");
      const charterDigest = taskCharterContentDigest(charter);
      const taskId = taskCharterTaskId(initialProjectIdentity, charterDigest);
      const baseState = createRepositoryState(taskId, charter.objective);
      const candidate: TaskState = {
        ...baseState,
        routingDisposition: "ROUTABLE",
        taskCharter: charter,
        taskCharterConfirmation: {
          confirmationId: "00000000-0000-4000-8000-000000000010",
          confirmedAt: "2026-10-07T00:00:00.000Z",
          projectIdentity: initialProjectIdentity,
          confirmedCharterDigest: charterDigest,
          channel: "explicit-task-charter-digest",
        },
      };
      const store = new FileDurableContextStore(rootPath);
      const admissionError = await store.createInitialProjectTaskIfEmpty!(candidate, initialProjectIdentity)
        .then(() => null, (error: unknown) => error);
      const afterEntries = await readdir(rootPath);
      const afterTaskIds = afterEntries.filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry));
      const historyBytesUnchanged = beforeBytes.equals(await readFile(historyPath));
      const candidateWasCreated = await store.load(candidate.taskId) !== null;

      expect({
        errorName: admissionError instanceof Error ? admissionError.name : null,
        afterEntries,
        afterTaskIds,
        historyBytesUnchanged,
        candidateWasCreated,
      }).toMatchObject({
        errorName: "InvalidTaskStateError",
        afterEntries: beforeEntries,
        afterTaskIds: [],
        historyBytesUnchanged: true,
        candidateWasCreated: false,
      });
    } finally {
      await Promise.all([
        rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
        rm(handoffFixtureRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
      ]);
    }
  });

  it("fails closed on a stale root reservation without blocking existing saves or another root", async () => {
    const rootPath = await createStoreRoot();
    const unrelatedRoot = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const existing = createRepositoryState(`task-${"8".repeat(24)}`, "existing task remains writable");
    const admissionPath = join(rootPath, ".root-admission");
    const ownerPath = join(admissionPath, "owner.json");
    const reservation = {
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000099",
      candidateKey: "f".repeat(64),
    };
    try {
      await store.createIfAbsent(existing);
      await mkdir(admissionPath);
      await writeFile(ownerPath, `${JSON.stringify(reservation)}\n`, "utf8");
      const staleTime = new Date(Date.now() - FILE_DURABLE_CONTEXT_LEASE_MS * 2);
      await utimes(admissionPath, staleTime, staleTime);

      const updated = await store.withTaskOwnership!(existing.taskId, existing.environment, async (lease) =>
        store.save({ ...existing, goal: "existing task update remains writable" }, lease));
      expect((await store.load(existing.taskId))?.goal).toBe("existing task update remains writable");
      await expect(store.createInitialProjectTaskIfEmpty!(
        createRepositoryState(`task-${"7".repeat(24)}`, "blocked by stale root reservation"), initialProjectIdentity,
      )).rejects.toThrow(/another durable task is being admitted/iu);
      expect(await readFile(ownerPath, "utf8")).toBe(`${JSON.stringify(reservation)}\n`);

      const unrelated = new FileDurableContextStore(unrelatedRoot);
      const unrelatedState = createRepositoryState(`task-${"6".repeat(24)}`, "unrelated root remains available");
      await expect(unrelated.createInitialProjectTaskIfEmpty!(unrelatedState, initialProjectIdentity))
        .resolves.toMatchObject({ taskId: unrelatedState.taskId });
      expect(updated.taskId).toBe(existing.taskId);
    } finally {
      await Promise.all([
        rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
        rm(unrelatedRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
      ]);
    }
  });

  it("treats EEXIST and EPERM with a verified reservation as contention and preserves unreadable owners", async () => {
    const existsRoot = await createStoreRoot();
    const permissionRoot = await createStoreRoot();
    const unreadableRoot = await createStoreRoot();
    const directoryOwnerRoot = await createStoreRoot();
    const candidate = createRepositoryState(`task-${"4".repeat(24)}`, "reservation acquisition boundary");
    const reservation = {
      schemaVersion: 1,
      token: "00000000-0000-4000-8000-000000000101",
      candidateKey: "f".repeat(64),
    };
    const reservationBytes = Buffer.from(`${JSON.stringify(reservation)}\n`, "utf8");
    const systemError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`synthetic ${code}`), { code });
    try {
      const existsPath = join(existsRoot, ".root-admission");
      await mkdir(existsPath);
      await writeFile(join(existsPath, "owner.json"), reservationBytes);
      const existsStore = new FileDurableContextStore(existsRoot, {
        createRootAdmissionReservation: async () => { throw systemError("EEXIST"); },
      });
      await expect(existsStore.createIfAbsent(candidate)).rejects.toMatchObject({
        name: "TaskOwnershipError",
        message: "Another durable task is being admitted at this root",
      });
      expect(await readFile(join(existsPath, "owner.json"))).toEqual(reservationBytes);

      const permissionPath = join(permissionRoot, ".root-admission");
      await mkdir(permissionPath);
      await writeFile(join(permissionPath, "owner.json"), reservationBytes);
      const permissionStore = new FileDurableContextStore(permissionRoot, {
        createRootAdmissionReservation: async () => { throw systemError("EPERM"); },
      });
      await expect(permissionStore.createIfAbsent(candidate)).rejects.toMatchObject({
        name: "TaskOwnershipError",
        message: "Another durable task is being admitted at this root",
      });
      expect(await readFile(join(permissionPath, "owner.json"))).toEqual(reservationBytes);

      const unreadablePath = join(unreadableRoot, ".root-admission");
      const unreadableOwnerPath = join(unreadablePath, "owner.json");
      const unreadableOwnerBytes = Buffer.from("{invalid", "utf8");
      await mkdir(unreadablePath);
      await writeFile(unreadableOwnerPath, unreadableOwnerBytes);
      const unreadableStore = new FileDurableContextStore(unreadableRoot, {
        createRootAdmissionReservation: async () => { throw systemError("EPERM"); },
      });
      await expect(unreadableStore.createIfAbsent(candidate)).rejects.toMatchObject({ name: "InvalidTaskStateError" });
      expect(await readFile(unreadableOwnerPath)).toEqual(unreadableOwnerBytes);
      expect(await unreadableStore.load(candidate.taskId)).toBeNull();

      const directoryOwnerReservation = join(directoryOwnerRoot, ".root-admission");
      const directoryOwnerPath = join(directoryOwnerReservation, "owner.json");
      await mkdir(directoryOwnerReservation);
      await mkdir(directoryOwnerPath);
      const directoryOwnerStore = new FileDurableContextStore(directoryOwnerRoot, {
        createRootAdmissionReservation: async () => { throw systemError("EPERM"); },
      });
      await expect(directoryOwnerStore.createIfAbsent(candidate)).rejects.toMatchObject({ name: "InvalidTaskStateError" });
      expect((await lstat(directoryOwnerReservation)).isDirectory()).toBe(true);
      expect((await lstat(directoryOwnerPath)).isDirectory()).toBe(true);
      expect(await directoryOwnerStore.load(candidate.taskId)).toBeNull();
    } finally {
      await Promise.all([existsRoot, permissionRoot, unreadableRoot, directoryOwnerRoot].map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
    }
  });

  it("retries one EPERM only after the reservation directory disappears", async () => {
    const rootPath = await createStoreRoot();
    const candidate = createRepositoryState(`task-${"3".repeat(24)}`, "single root reservation retry");
    let acquisitionAttempts = 0;
    const systemError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`synthetic ${code}`), { code });
    const store = new FileDurableContextStore(rootPath, {
      createRootAdmissionReservation: async (path) => {
        acquisitionAttempts += 1;
        if (acquisitionAttempts === 1) {
          await mkdir(path);
          await rm(path, { recursive: true });
          throw systemError("EPERM");
        }
        await mkdir(path);
      },
    });
    try {
      await expect(store.createIfAbsent(candidate)).resolves.toMatchObject({ taskId: candidate.taskId });
      expect(acquisitionAttempts).toBe(2);
      expect(await store.load(candidate.taskId)).toMatchObject({ taskId: candidate.taskId });
    } finally {
      await rm(rootPath, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  });

  it("fails closed on repeated EPERM or an inaccessible reservation root", async () => {
    const repeatedRoot = await createStoreRoot();
    const inaccessibleRoot = await createStoreRoot();
    const candidate = createRepositoryState(`task-${"2".repeat(24)}`, "permission error must not become contention");
    const systemError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`synthetic ${code}`), { code });
    let repeatedAttempts = 0;
    let inaccessibleAttempts = 0;
    let inaccessibleInspections = 0;
    const repeatedStore = new FileDurableContextStore(repeatedRoot, {
      createRootAdmissionReservation: async () => {
        repeatedAttempts += 1;
        throw systemError("EPERM");
      },
    });
    const inaccessibleStore = new FileDurableContextStore(inaccessibleRoot, {
      createRootAdmissionReservation: async () => {
        inaccessibleAttempts += 1;
        throw systemError("EPERM");
      },
      lstatRootAdmissionReservation: async () => {
        inaccessibleInspections += 1;
        throw systemError("EACCES");
      },
    });
    try {
      await expect(repeatedStore.createIfAbsent(candidate)).rejects.toMatchObject({
        name: "InvalidTaskStateError",
        message: expect.stringContaining("repeated EPERM"),
      });
      expect(repeatedAttempts).toBe(2);
      expect(await readdir(repeatedRoot)).toEqual([]);

      await expect(inaccessibleStore.createIfAbsent(candidate)).rejects.toMatchObject({
        name: "InvalidTaskStateError",
        message: expect.stringContaining("could not be verified after EPERM"),
      });
      expect(inaccessibleAttempts).toBe(1);
      expect(inaccessibleInspections).toBe(1);
      expect(await readdir(inaccessibleRoot)).toEqual([]);
      expect(await inaccessibleStore.load(candidate.taskId)).toBeNull();
    } finally {
      await Promise.all([repeatedRoot, inaccessibleRoot].map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
    }
  });

  it("rejects EPERM when the reservation path is not a real directory", async () => {
    const fileRoot = await createStoreRoot();
    const symlinkRoot = await createStoreRoot();
    const candidate = createRepositoryState(`task-${"1".repeat(24)}`, "unverifiable reservation type");
    const systemError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`synthetic ${code}`), { code });
    const filePath = join(fileRoot, ".root-admission");
    const fileBytes = Buffer.from("not a reservation directory", "utf8");
    await writeFile(filePath, fileBytes);
    const fileStore = new FileDurableContextStore(fileRoot, {
      createRootAdmissionReservation: async () => { throw systemError("EPERM"); },
    });
    const symlinkStore = new FileDurableContextStore(symlinkRoot, {
      createRootAdmissionReservation: async () => { throw systemError("EPERM"); },
      lstatRootAdmissionReservation: async () => ({ isDirectory: () => true, isSymbolicLink: () => true }),
    });
    try {
      await expect(fileStore.createIfAbsent(candidate)).rejects.toMatchObject({
        name: "InvalidTaskStateError",
        message: "Root admission path is not a verifiable reservation directory",
      });
      expect(await readFile(filePath)).toEqual(fileBytes);
      expect(await fileStore.load(candidate.taskId)).toBeNull();

      await expect(symlinkStore.createIfAbsent(candidate)).rejects.toMatchObject({
        name: "InvalidTaskStateError",
        message: "Root admission path is not a verifiable reservation directory",
      });
      expect(await readdir(symlinkRoot)).toEqual([]);
      expect(await symlinkStore.load(candidate.taskId)).toBeNull();
    } finally {
      await Promise.all([fileRoot, symlinkRoot].map((root) => rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 })));
    }
  });

  it("fails closed on malformed reservations and preserves a changed reservation owner", async () => {
    const malformedRoot = await createStoreRoot();
    const changedOwnerRoot = await createStoreRoot();
    const malformedReservation = join(malformedRoot, ".root-admission");
    const malformedOwnerPath = join(malformedReservation, "owner.json");
    const candidate = createRepositoryState(`task-${"5".repeat(24)}`, "malformed reservation candidate");
    let reachedPrepublication!: () => void;
    const prepublication = new Promise<void>((resolvePromise) => { reachedPrepublication = resolvePromise; });
    const charter = approvedCharter(initialProjectIdentity, "foreign reservation owner fixture");
    const charterDigest = taskCharterContentDigest(charter);
    const charterTaskId = taskCharterTaskId(initialProjectIdentity, charterDigest);
    const baseState = createRepositoryState(charterTaskId, charter.objective);
    const approvedState: TaskState = {
      ...baseState,
      routingDisposition: "ROUTABLE",
      taskCharter: charter,
      taskCharterConfirmation: {
        confirmationId: "00000000-0000-4000-8000-000000000010",
        confirmedAt: "2026-10-07T00:00:00.000Z",
        projectIdentity: initialProjectIdentity,
        confirmedCharterDigest: charterDigest,
        channel: "explicit-task-charter-digest",
      },
    };
    const foreignOwnerToken = "00000000-0000-4000-8000-000000000098";
    const changedOwnerStore = new FileDurableContextStore(changedOwnerRoot, {
      afterInitialCompanionsWritten: async () => {
        reachedPrepublication();
        const ownerPath = join(changedOwnerRoot, ".root-admission", "owner.json");
        const current = JSON.parse(await readFile(ownerPath, "utf8")) as { schemaVersion: number; token: string; candidateKey: string };
        await writeFile(ownerPath, `${JSON.stringify({ ...current, token: foreignOwnerToken })}\n`, "utf8");
        throw new Error("synthetic prepublication abort after owner change");
      },
    });
    try {
      await mkdir(malformedReservation);
      await writeFile(malformedOwnerPath, "{malformed", "utf8");
      const malformedBytes = await readFile(malformedOwnerPath);
      await expect(new FileDurableContextStore(malformedRoot).createIfAbsent(candidate))
        .rejects.toThrow(/unreadable reservation/u);
      expect(await readFile(malformedOwnerPath)).toEqual(malformedBytes);
      expect(await new FileDurableContextStore(malformedRoot).load(candidate.taskId)).toBeNull();

      const attempt = changedOwnerStore.createInitialProjectTaskIfEmpty!(approvedState, initialProjectIdentity);
      await prepublication;
      await expect(attempt).rejects.toThrow(/ownership changed before release/u);
      const changedOwnerPath = join(changedOwnerRoot, ".root-admission", "owner.json");
      expect(JSON.parse(await readFile(changedOwnerPath, "utf8"))).toMatchObject({ token: foreignOwnerToken });
      expect(await changedOwnerStore.load(charterTaskId)).toBeNull();
      expect((await readdir(changedOwnerRoot)).filter((entry) => /^task-[a-f0-9]{24}$/u.test(entry))).toEqual([]);
    } finally {
      await Promise.all([
        rm(malformedRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
        rm(changedOwnerRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 }),
      ]);
    }
  });

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

  it("round-trips routing dispositions while preserving legacy absence and rejecting unknown values", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    try {
      const legacy = createState("task-routing-legacy", "Preserve legacy routing default");
      await store.save(legacy);
      expect(await store.load(legacy.taskId)).not.toHaveProperty("routingDisposition");

      for (const [index, routingDisposition] of (["ROUTABLE", "PAUSED_RESUMABLE", "LEGACY_FROZEN"] as const).entries()) {
        const state = { ...createState(`task-routing-${index}`, "Persist routing disposition"), routingDisposition };
        await store.save(state);
        expect((await store.load(state.taskId))?.routingDisposition).toBe(routingDisposition);
      }

      const invalid = { ...createState("task-routing-invalid", "Reject invalid routing disposition"), routingDisposition: "UNKNOWN" } as unknown as TaskState;
      await expect(store.save(invalid)).rejects.toThrow("Invalid task state");
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
      const contextPath = join(rootPath, state.taskId, "generations", manifest.manifestId, "context.json");
      const expectedHash = manifest.hashes[join(rootPath, state.taskId, "context.json")];
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
      const statePath = join(rootPath, state.taskId, "generations", manifest.manifestId, "state.json");
      const expectedHash = manifest.hashes[join(rootPath, state.taskId, "state.json")];
      if (expectedHash === undefined) {
        throw new Error("Expected a state hash");
      }
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as { goal: string };
      persisted.goal = "changed";
      await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

      await expect(store.load(state.taskId)).rejects.toThrow(
        new RegExp(`task-tampered-state.*${join(rootPath, state.taskId, "state.json").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*${expectedHash}.*[a-f0-9]{64}`),
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
      const manifestPath = join(rootPath, state.taskId, "generations", manifest.manifestId, "manifest.json");
      const expectedHash = manifest.hashes[join(rootPath, state.taskId, "manifest.json")];
      if (expectedHash === undefined) {
        throw new Error("Expected a manifest hash");
      }
      const persisted = JSON.parse(await readFile(manifestPath, "utf8")) as { recordedAt: string };
      persisted.recordedAt = "2026-01-01T00:00:00.000Z";
      await writeFile(manifestPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

      await expect(store.load(state.taskId)).rejects.toThrow(
        new RegExp(`task-tampered-manifest.*${join(rootPath, state.taskId, "manifest.json").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}.*${expectedHash}.*[a-f0-9]{64}`),
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
      const evidencePath = join(rootPath, state.taskId, "generations", manifest.manifestId, "evidence.json");
      const expectedHash = manifest.hashes[join(rootPath, state.taskId, "evidence.json")];
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
    let statePath: string;

    try {
      const manifest = await store.save(state);
      statePath = join(rootPath, state.taskId, "generations", manifest.manifestId, "state.json");
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
    let artifactPath: string;

    try {
      const manifest = await store.save(state);
      artifactPath = join(rootPath, state.taskId, "generations", manifest.manifestId, artifact);
      await rm(artifactPath);

      await expect(store.load(state.taskId)).rejects.toThrow(/required durable artifact|missing|integrity/i);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid persisted state during recovery", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    let statePath: string;

    try {
      const manifest = await store.save(createState("task-invalid", "Reject invalid state"));
      statePath = join(rootPath, "task-invalid", "generations", manifest.manifestId, "state.json");
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

  it.each([
    'credential="quoted-secret"',
    "password=plain-secret",
    "Authorization: Bearer plain-token",
    'access-token="quoted-secret"',
    "private_key='quoted-secret'",
    'cookie="quoted-secret"',
    "session-token='quoted-secret'",
    "auth=plain-secret",
  ])("rejects credential-shaped assignments before durable persistence: %s", async (goal) => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    try {
      await expect(store.save({ ...createState(`task-quoted-${goal.slice(0, 5).replace(/[^A-Za-z0-9]/g, "x")}`, goal) })).rejects.toThrow(/secret-like|credential/i);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("round-trips path-keyed SHA-256 maps beneath their exact typed schema fields", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "d-ai-context-U4AUth-path-map-"));
    const store = new FileDurableContextStore(rootPath);
    const taskId = "task-path-map-allowlist";
    const digest = "b".repeat(64);
    const pathKey = join(rootPath, "ordinary-auth", "authorization.json");
    const manifest = {
      manifestId: "00000000-0000-4000-8000-000000000002",
      taskId,
      stage: "execute" as const,
      environment: "work" as const,
      role: "implementer" as const,
      durablePaths: [pathKey],
      hashes: { [pathKey]: digest },
      recoveryPointId: "recovery-path-map",
      recordedAt: "2026-08-21T00:00:00.000Z",
    };
    const recoveryPoint = {
      recoveryPointId: "recovery-path-map",
      taskId,
      stage: "execute" as const,
      environment: "work" as const,
      role: "implementer" as const,
      durablePaths: [pathKey],
      hashes: { [pathKey]: digest },
      restorationInstructions: "Restore the captured state",
      createdAt: "2026-08-21T00:00:00.000Z",
    };
    const snapshot = createRecoverySnapshot(taskId);
    const state: TaskState = {
      ...createState(taskId, "Preserve path-keyed hash maps"),
      recoveryPoint,
      recoverySnapshot: {
        ...snapshot,
        stateManifest: { ...manifest, hashes: { [pathKey]: digest } },
        durableArtifacts: { [pathKey]: digest },
      },
      durableContext: manifest,
      closeCandidate: {
        taskId,
        durableContext: manifest,
        contextManifest: [pathKey],
        repositoryPath: rootPath,
        remote: "origin",
        ref: "refs/heads/main",
        commitSha: "c".repeat(40),
        criticalUnsavedContext: [],
        recordedAt: "2026-08-21T00:00:00.000Z",
      },
    };

    try {
      const firstManifest = await store.save(state);
      const reloadedStore = new FileDurableContextStore(rootPath);
      const recovered = await reloadedStore.load(taskId);
      expect(recovered).not.toBeNull();
      expect(recovered?.recoveryPoint?.hashes).toEqual({ [pathKey]: digest });
      expect(recovered?.recoverySnapshot?.stateManifest.hashes).toEqual({ [pathKey]: digest });
      expect(recovered?.recoverySnapshot?.durableArtifacts).toEqual({ [pathKey]: digest });
      expect(recovered?.closeCandidate?.durableContext.hashes).toEqual({ [pathKey]: digest });
      expect(firstManifest.hashes).toEqual(expect.objectContaining({
        [join(rootPath, taskId, "state.json")]: expect.stringMatching(/^[a-f0-9]{64}$/),
        [join(rootPath, taskId, "manifest.json")]: expect.stringMatching(/^[a-f0-9]{64}$/),
      }));
      if (recovered === null) throw new Error("Expected recovered task state");
      if (recovered.durableContext === null) throw new Error("Expected recovered durable context");
      const rootCandidate = {
        taskId,
        durableContext: { ...recovered.durableContext, hashes: { [pathKey]: digest } },
        contextManifest: [pathKey],
        repositoryPath: rootPath,
        remote: "origin",
        ref: "refs/heads/main",
        commitSha: "c".repeat(40),
        criticalUnsavedContext: [],
        recordedAt: "2026-08-21T00:00:00.000Z",
      };
      await reloadedStore.withTaskOwnership(taskId, "work", async (lease) => reloadedStore.saveCloseCandidate(rootCandidate, lease));
      const recoveredCandidate = await new FileDurableContextStore(rootPath).loadCloseCandidate(taskId);
      expect(recoveredCandidate?.durableContext.hashes).toEqual({ [pathKey]: digest });
      const secretCandidatePath = "C:/synthetic/ghp_123456789012345678901234567890/context.json";
      let candidateRejection: unknown;
      try {
        await reloadedStore.withTaskOwnership(taskId, "work", async (lease) => reloadedStore.saveCloseCandidate({
          ...rootCandidate,
          durableContext: { ...rootCandidate.durableContext, hashes: { [secretCandidatePath]: digest } },
        }, lease));
      } catch (error: unknown) {
        candidateRejection = error;
      }
      expect(candidateRejection).toBeInstanceOf(InvalidTaskStateError);
      expect(String(candidateRejection)).not.toContain(secretCandidatePath);
      await expect(new FileDurableContextStore(rootPath).loadCloseCandidate(taskId)).resolves.toEqual(recoveredCandidate);
      await reloadedStore.withTaskOwnership(taskId, "work", async (lease) => reloadedStore.save(recovered, lease));
      await expect(new FileDurableContextStore(rootPath).load(taskId)).resolves.toMatchObject({
        goal: state.goal,
        constraints: state.constraints,
        contextManifest: state.contextManifest,
        recoveryPoint: { hashes: { [pathKey]: digest } },
        recoverySnapshot: {
          stateManifest: { hashes: { [pathKey]: digest } },
          durableArtifacts: { [pathKey]: digest },
        },
        closeCandidate: { durableContext: { hashes: { [pathKey]: digest } } },
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects secret-shaped path keys without exposing them or changing the active snapshot", async () => {
    const rootPath = await mkdtemp(join(tmpdir(), "d-ai-context-U4AUth-secret-path-"));
    const store = new FileDurableContextStore(rootPath);
    const taskId = "task-secret-path-key";
    const state = {
      ...createState(taskId, "Keep the current snapshot on rejection"),
      recoveryPoint: {
        recoveryPointId: "recovery-secret-path",
        taskId,
        stage: "execute" as const,
        environment: "work" as const,
        role: "implementer" as const,
        durablePaths: ["context.json"],
        hashes: { "context.json": "d".repeat(64) },
        restorationInstructions: "Restore the captured state",
        createdAt: "2026-08-21T00:00:00.000Z",
      },
    } satisfies TaskState;
    const secretPath = "C:/synthetic/ghp_123456789012345678901234567890/context.json";

    try {
      await store.save(state);
      const statePath = join(rootPath, taskId, "state.json");
      const beforeState = await readFile(statePath, "utf8");
      const before = await store.load(taskId);
      if (before?.recoveryPoint === null || before?.recoveryPoint === undefined) throw new Error("Expected active recovery point");
      const invalidState: TaskState = {
        ...before,
        recoveryPoint: { ...before.recoveryPoint, hashes: { [secretPath]: "e".repeat(64) } },
      };

      let rejection: unknown;
      try {
        await store.withTaskOwnership(taskId, "work", async (lease) => store.save(invalidState, lease));
      } catch (error: unknown) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(InvalidTaskStateError);
      expect(String(rejection)).not.toContain(secretPath);
      expect(await readFile(statePath, "utf8")).toBe(beforeState);
      await expect(store.load(taskId)).resolves.toMatchObject({
        goal: state.goal,
        recoveryPoint: before.recoveryPoint,
        durableContext: before.durableContext,
      });

      const ordinaryPath = "C:/ordinary-auth/context.json";
      const malformedInputs = [
        { ...before, recoveryPoint: { ...before.recoveryPoint, hashes: { [ordinaryPath]: "not-a-digest" } } },
        { ...before, recoveryPoint: { ...before.recoveryPoint, hashes: { [ordinaryPath]: { nested: "value" } } } },
        { ...before, recoveryPoint: { ...before.recoveryPoint, unexpectedSibling: true } },
        { ...before, hashes: { [ordinaryPath]: "f".repeat(64) } },
        { ...before, "recoveryPoint.hashes": { [ordinaryPath]: "f".repeat(64) } },
        { ...before, "recoveryPoint/hashes": { [ordinaryPath]: "f".repeat(64) } },
        { ...before, recoveryPoint: [{ ...before.recoveryPoint, hashes: { [ordinaryPath]: "f".repeat(64) } }] },
        {
          ...before,
          routingDecision: {
            stage: "execute" as const,
            environment: "work" as const,
            role: "implementer" as const,
            selectedModel: "model",
            selectedCapabilities: [],
            reason: "synthetic invalid credential field",
            overrideSource: "default" as const,
            authorization: "synthetic-secret",
          },
        },
      ] as unknown as TaskState[];
      for (const malformed of malformedInputs) {
        await expect(store.withTaskOwnership(taskId, "work", async (lease) => store.save(malformed, lease)))
          .rejects.toBeInstanceOf(InvalidTaskStateError);
        expect(await readFile(statePath, "utf8")).toBe(beforeState);
      }
      await expect(store.load(taskId)).resolves.toEqual(before);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("atomically replaces a prior durable snapshot", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const first = createState("task-replace", "Initial goal");
    const second = createState("task-replace", "Replacement goal");

    try {
      await store.save(first);
      await store.withTaskOwnership(second.taskId, second.environment, async (lease) => {
        await store.save(second, lease);
      });

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

      const transfer = JSON.parse(await readFile(join(await latestOwnershipGenerationPath(rootPath, "task-transfer"), "transfer.json"), "utf8")) as {
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
      await utimes(join(await latestOwnershipGenerationPath(rootPath, "task-stale-write"), "lease"), expiredAt, expiredAt);

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

      const statePath = join(rootPath, state.taskId, "generations", manifest.manifestId, "state.json");
      const persistedState = JSON.parse(await readFile(statePath, "utf8")) as { recoverySnapshot: { status: string } };
      persistedState.recoverySnapshot.status = "tampered";
      await writeFile(statePath, `${JSON.stringify(persistedState, null, 2)}\n`, "utf8");
      await expect(store.load(state.taskId)).rejects.toThrow(/canonical state hash mismatch|content hash mismatch/i);
      expect(manifest.hashes[join(rootPath, state.taskId, "state.json")]).toMatch(/^[a-f0-9]{64}$/);
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

  it("atomically creates a task once when two stores race to initialize it", async () => {
    const rootPath = await createStoreRoot();
    const firstStore = new FileDurableContextStore(rootPath);
    const secondStore = new FileDurableContextStore(rootPath);
    const firstState = createState("task-atomic-create", "First initializer");
    const secondState = { ...firstState, goal: "Second initializer" };

    try {
      const results = await Promise.allSettled([
        firstStore.save(firstState),
        secondStore.createIfAbsent!(secondState),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      await expect(firstStore.load(firstState.taskId)).resolves.toMatchObject({ goal: expect.stringMatching(/initializer/) });
      await expect(firstStore.save({ ...firstState, goal: "unauthorized overwrite" })).rejects.toThrow(/require ownership|already exists/i);

      const legacyState = createState("task-initial-save", "Initial save wins");
      await firstStore.save(legacyState);
      await expect(secondStore.createIfAbsent!(legacyState)).rejects.toThrow(/already exists|being created/i);
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("recovers a stale initial-creation reservation after an interrupted process", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-stale-initialization", "Recover interrupted initialization");
    const reservationPath = join(rootPath, state.taskId, "initializing");
    const staleAt = new Date(Date.now() - FILE_DURABLE_CONTEXT_LEASE_MS - 1_000);

    try {
      await mkdir(join(rootPath, state.taskId), { recursive: true });
      await writeFile(reservationPath, `${state.taskId}\n`, "utf8");
      await utimes(reservationPath, staleAt, staleAt);

      await expect(store.createIfAbsent!(state)).resolves.toMatchObject({ taskId: state.taskId });
      await expect(store.load(state.taskId)).resolves.toMatchObject({ taskId: state.taskId, goal: state.goal });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("loads the selected generation when a newer top-level companion mirror is unpublished", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const firstState = createState("task-unpublished-companion", "Published generation");
    const secondState = {
      ...firstState,
      goal: "Unpublished generation",
      contextManifest: ["workspace:unpublished"],
      handoffState: "completed" as const,
    };

    try {
      await store.withTaskOwnership(firstState.taskId, firstState.environment, async (lease) => {
        await store.save(firstState, lease);
        await writeFile(
          join(rootPath, firstState.taskId, "context.json"),
          `${JSON.stringify({ goal: secondState.goal, constraints: secondState.constraints, contextManifest: secondState.contextManifest })}\n`,
          "utf8",
        );
        await writeFile(
          join(rootPath, firstState.taskId, "handoff.json"),
          `${JSON.stringify({ handoffState: secondState.handoffState })}\n`,
          "utf8",
        );
      });

      await expect(store.load(firstState.taskId)).resolves.toMatchObject({ goal: firstState.goal });
      await expect(store.load(firstState.taskId)).resolves.toMatchObject({
        contextManifest: firstState.contextManifest,
        handoffState: firstState.handoffState,
      });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("verifies the submitted immutable generation when top-level mirrors are stale", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-verify-generation", "Verify the immutable generation");

    try {
      const manifest = await store.save(state);
      await writeFile(join(rootPath, state.taskId, "manifest.json"), "not the active manifest\n", "utf8");
      await writeFile(join(rootPath, state.taskId, "context.json"), "not the active context\n", "utf8");

      await expect(store.verifyDurableSnapshot(manifest)).resolves.toBeUndefined();
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

  it("rejects an active pointer whose filename generation disagrees with its payload", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const state = createState("task-pointer-generation-mismatch", "Reject mismatched pointer");

    try {
      await store.withTaskOwnership(state.taskId, state.environment, async (lease) => {
        await store.save(state, lease);
      });

      const pointerPath = join(rootPath, state.taskId, "active", "00000000000000000001.json");
      const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as { readonly manifestId: string; readonly ownershipGeneration: string };
      await writeFile(pointerPath, `${JSON.stringify({ ...pointer, ownershipGeneration: "2" })}\n`, "utf8");

      await expect(store.load(state.taskId)).rejects.toBeInstanceOf(InvalidTaskStateError);
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
        const leasePath = join(await latestOwnershipGenerationPath(rootPath, "task-heartbeat-failure"), "lease");
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
