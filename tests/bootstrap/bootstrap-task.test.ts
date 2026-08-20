import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

async function createDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("bootstrapTask", () => {
  it("creates and persists a new bootstrap task without changing workspace content", async () => {
    const storeRoot = await createDirectory("d-ai-bootstrap-store-");
    const workspacePath = await createDirectory("d-ai-bootstrap-workspace-");
    const workspaceFile = join(workspacePath, "workspace.txt");
    await writeFile(workspaceFile, "unchanged", "utf8");
    const store = new FileDurableContextStore(storeRoot);

    try {
      const state = await bootstrapTask(
        { taskId: null, goal: "Prepare a plan", environment: "work", workspacePath, repositoryPath: null },
        store,
      );

      expect(state.stage).toBe("bootstrap");
      expect(state.durableContext).not.toBeNull();
      expect(await store.load(state.taskId)).toMatchObject({ taskId: state.taskId });
      await expect(readFile(workspaceFile, "utf8")).resolves.toBe("unchanged");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("recovers an existing task when its read-only identity is unchanged", async () => {
    const storeRoot = await createDirectory("d-ai-bootstrap-store-");
    const workspacePath = await createDirectory("d-ai-bootstrap-workspace-");
    await writeFile(join(workspacePath, "workspace.txt"), "stable", "utf8");
    const store = new FileDurableContextStore(storeRoot);

    try {
      const first = await bootstrapTask(
        { taskId: "task-existing", goal: "Recover me", environment: "work", workspacePath, repositoryPath: null },
        store,
      );
      const recovered = await bootstrapTask(
        { taskId: first.taskId, goal: "Recover me", environment: "work", workspacePath, repositoryPath: null },
        store,
      );

      expect(recovered).toEqual(first);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("rejects recovery when the inspected workspace identity changes", async () => {
    const storeRoot = await createDirectory("d-ai-bootstrap-store-");
    const workspacePath = await createDirectory("d-ai-bootstrap-workspace-");
    const workspaceFile = join(workspacePath, "workspace.txt");
    await writeFile(workspaceFile, "before", "utf8");
    const store = new FileDurableContextStore(storeRoot);

    try {
      await bootstrapTask(
        { taskId: "task-mismatch", goal: "Inspect safely", environment: "work", workspacePath, repositoryPath: null },
        store,
      );
      await writeFile(workspaceFile, "after", "utf8");

      await expect(
        bootstrapTask(
          { taskId: "task-mismatch", goal: "Inspect safely", environment: "work", workspacePath, repositoryPath: null },
          store,
        ),
      ).rejects.toThrow("identity mismatch");
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
