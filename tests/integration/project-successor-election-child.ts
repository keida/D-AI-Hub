import { FileDurableContextStore } from "../../src/state/file-durable-context-store.js";
import type { TaskState } from "../../src/domain/types.js";

interface ChildRequest {
  readonly root: string;
  readonly projectIdentity: string;
  readonly charterDigest: string;
  readonly state: TaskState;
  readonly action: "publish" | "register";
}

type ChildMessage =
  | { readonly type: "begin"; readonly request: ChildRequest }
  | { readonly type: "publish" };

let started = false;

process.on("message", (message: ChildMessage) => {
  if (message.type !== "begin" || started) return;
  started = true;
  void run(message.request);
});

async function run(request: ChildRequest): Promise<void> {
  try {
    const store = new FileDurableContextStore(request.root);
    const registration = await store.registerProjectSuccessorContender(request.state, request.projectIdentity, request.charterDigest);
    process.send?.({ type: "ready", registration, taskId: request.state.taskId });
    if (request.action === "register") {
      process.send?.({ type: "result", outcome: "registered" });
      return;
    }
    await new Promise<void>((resolve) => {
      const onPublish = (message: ChildMessage) => {
        if (message.type !== "publish") return;
        process.off("message", onPublish);
        resolve();
      };
      process.on("message", onPublish);
    });
    const manifest = await store.createSuccessorIfAbsent(request.state, request.projectIdentity, request.charterDigest);
    process.send?.({ type: "result", outcome: "published", taskId: manifest.taskId, manifestId: manifest.manifestId });
  } catch (error: unknown) {
    process.send?.({
      type: "result",
      outcome: "error",
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  } finally {
    process.disconnect?.();
  }
}
