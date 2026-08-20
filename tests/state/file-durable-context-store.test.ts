import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TaskState } from "../../src/domain/types.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

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
      await store.recordCriticalUnsavedContext(state.taskId, ["uncommitted migration"]);
      await expect(store.load(state.taskId)).resolves.toMatchObject({
        criticalUnsavedContext: ["uncommitted migration"],
      });

      await store.clearCriticalUnsavedContext(state.taskId);
      await expect(store.load(state.taskId)).resolves.toMatchObject({ criticalUnsavedContext: [] });
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });
});
import { createHash } from "node:crypto";
