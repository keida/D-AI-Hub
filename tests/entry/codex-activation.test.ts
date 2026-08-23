import { describe, expect, it } from "vitest";
import { createCodexActivation } from "../../src/entry/codex-activation.js";
import type { DAIResponse, ExternalDAIRequest } from "../../src/runtime/d-ai-runtime.js";

describe("Codex D-AI activation", () => {
  it("parses a raw logical close command and selects the explicit durable task", async () => {
    const requests: ExternalDAIRequest[] = [];
    const runtime = async (request: ExternalDAIRequest): Promise<DAIResponse> => {
      requests.push(request);
      return {
        taskId: request.activeTaskId ?? "unassigned",
        stage: "close",
        environment: "codex",
        status: "completed",
        evidence: [],
        message: "Safe-to-delete: YES",
      };
    };
    const activate = createCodexActivation(runtime);

    const result = await activate({ rawCommand: "@D-AI close", taskId: "task-explicit" });

    expect(requests).toEqual([{
      command: { kind: "close" },
      sourceEnvironment: "codex",
      overrides: { model: null, role: null, environment: null, stage: null },
      activeTaskId: "task-explicit",
    }]);
    expect(result).toMatchObject({ taskId: "task-explicit", status: "completed", message: "Safe-to-delete: YES" });
  });

  it("keeps a fresh close fail-closed when the runtime reports no matching workspace task", async () => {
    const runtime = async (): Promise<DAIResponse> => ({
      taskId: "unassigned",
      stage: "bootstrap",
      environment: "codex",
      status: "blocked",
      evidence: [],
      message: "No active task is available for close",
    });
    const activate = createCodexActivation(runtime);

    const result = await activate({ rawCommand: "@D-AI close", taskId: null });

    expect(result.status).toBe("blocked");
    expect(result.message).toContain("No active task is available for close");
  });
});
