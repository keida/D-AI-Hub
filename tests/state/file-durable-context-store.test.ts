import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      expect(Object.keys(manifest.hashes)).toHaveLength(5);
      expect(Object.values(manifest.hashes)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}$/)]),
      );
      const contextPath = manifest.durablePaths[0];
      if (contextPath === undefined) {
        throw new Error("Expected a durable context path");
      }
      const content = await readFile(contextPath, "utf8");
      expect(manifest.hashes[contextPath]).toBe(createHash("sha256").update(content, "utf8").digest("hex"));
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects invalid persisted state during recovery", async () => {
    const rootPath = await createStoreRoot();
    const store = new FileDurableContextStore(rootPath);
    const statePath = join(rootPath, "task-invalid", "state.json");

    try {
      await mkdir(join(rootPath, "task-invalid"), { recursive: true });
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
