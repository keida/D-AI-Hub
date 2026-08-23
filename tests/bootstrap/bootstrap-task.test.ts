import { createHash } from "node:crypto";
import { lstat, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bootstrapTask, prepareBootstrapTask } from "../../src/bootstrap/bootstrap-task.js";
import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";

async function createDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function hashWorkspace(path: string): Promise<string> {
  const entry = await lstat(path);
  if (entry.isFile()) {
    return createHash("sha256").update(`file:${path}:${await readFile(path)}`).digest("hex");
  }
  if (!entry.isDirectory()) {
    return createHash("sha256").update(`other:${path}`).digest("hex");
  }
  const childHashes = await Promise.all(
    (await readdir(path)).sort().map(async (name) => hashWorkspace(join(path, name))),
  );
  return createHash("sha256").update(`directory:${path}:${childHashes.join(":")}`).digest("hex");
}

describe("bootstrapTask", () => {
  it("prepares a new task without persisting before ownership is acquired", async () => {
    const storeRoot = await createDirectory("d-ai-bootstrap-store-");
    const workspacePath = await createDirectory("d-ai-bootstrap-workspace-");
    const store = new FileDurableContextStore(storeRoot);

    try {
      const state = await prepareBootstrapTask(
        { taskId: null, goal: "Prepare without writing", environment: "work", workspacePath, repositoryPath: null },
        store,
      );

      expect(state.durableContext).toBeNull();
      await expect(store.load(state.taskId)).resolves.toBeNull();
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it("creates and persists a new bootstrap task without changing workspace content", async () => {
    const storeRoot = await createDirectory("d-ai-bootstrap-store-");
    const workspacePath = await createDirectory("d-ai-bootstrap-workspace-");
    const workspaceFile = join(workspacePath, "workspace.txt");
    await writeFile(workspaceFile, "unchanged", "utf8");
    const store = new FileDurableContextStore(storeRoot);
    const workspaceHashBefore = await hashWorkspace(workspacePath);

    try {
      const state = await bootstrapTask(
        { taskId: null, goal: "Prepare a plan", environment: "work", workspacePath, repositoryPath: null },
        store,
      );

      expect(state.stage).toBe("bootstrap");
      expect(state.durableContext).not.toBeNull();
      expect(await store.load(state.taskId)).toMatchObject({ taskId: state.taskId });
      await expect(readFile(workspaceFile, "utf8")).resolves.toBe("unchanged");
      expect(await hashWorkspace(workspacePath)).toBe(workspaceHashBefore);
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

  it("changes the derived task identity when binary bytes change in place", async () => {
    const storeRoot = await createDirectory("d-ai-bootstrap-store-");
    const workspacePath = await createDirectory("d-ai-bootstrap-workspace-");
    const binaryPath = join(workspacePath, "payload.bin");
    const store = new FileDurableContextStore(storeRoot);

    try {
      await writeFile(binaryPath, Buffer.from([0x80]));
      const first = await prepareBootstrapTask(
        { taskId: null, goal: "Hash binary content", environment: "work", workspacePath, repositoryPath: null },
        store,
      );

      await writeFile(binaryPath, Buffer.from([0x81]));
      const second = await prepareBootstrapTask(
        { taskId: null, goal: "Hash binary content", environment: "work", workspacePath, repositoryPath: null },
        store,
      );

      expect(second.taskId).not.toBe(first.taskId);
    } finally {
      await rm(storeRoot, { recursive: true, force: true });
      await rm(workspacePath, { recursive: true, force: true });
    }
  });
});
