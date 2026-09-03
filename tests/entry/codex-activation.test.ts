import { describe, expect, it } from "vitest";
import type { DeliveryResult } from "../../src/automation/delivery.js";
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

  it("passes routing overrides from the logical command into the runtime", async () => {
    const requests: ExternalDAIRequest[] = [];
    const runtime = async (request: ExternalDAIRequest): Promise<DAIResponse> => {
      requests.push(request);
      return { taskId: "task-override", stage: "verify", environment: "codex", status: "accepted", evidence: [], message: "accepted" };
    };
    const activate = createCodexActivation(runtime);

    await activate({ rawCommand: "@D-AI continue task-override model=gpt-5 role=reviewer stage=verify", taskId: null });

    expect(requests[0]?.overrides).toEqual({ model: "gpt-5", role: "reviewer", environment: null, stage: "verify" });
    expect(requests[0]?.command).toEqual({ kind: "continue", taskIdOrProject: "task-override" });
  });

  it("makes natural-language discussion read-only without invoking the durable runtime", async () => {
    let runtimeCalls = 0;
    const runtime = async (): Promise<DAIResponse> => {
      runtimeCalls += 1;
      throw new Error("discussion must not invoke the durable runtime");
    };
    const activate = createCodexActivation(runtime);

    const result = await activate({ rawCommand: "这个方案是不是应该改成 SQLite？", taskId: null });

    expect(runtimeCalls).toBe(0);
    expect(result).toMatchObject({
      taskId: "unassigned",
      stage: "inspect",
      environment: "codex",
      status: "accepted",
      userIntent: { intent: "discuss", risk: "read-only", expectedEndpoint: "discussion" },
    });
    expect(result.message).toMatch(/read-only discussion/i);
  });

  it("routes natural-language continuation to the existing durable runtime", async () => {
    const requests: ExternalDAIRequest[] = [];
    const runtime = async (request: ExternalDAIRequest): Promise<DAIResponse> => {
      requests.push(request);
      return { taskId: "task-continue", stage: "execute", environment: "codex", status: "accepted", evidence: [], message: "continued" };
    };
    const activate = createCodexActivation(runtime);

    const result = await activate({ rawCommand: "继续 D-AI-Hub", taskId: null });

    expect(requests[0]?.command).toEqual({ kind: "continue", taskIdOrProject: "D-AI-Hub" });
    expect(result).toMatchObject({ status: "accepted", userIntent: { intent: "continue", project: "D-AI-Hub" } });
  });

  it("keeps an explicit status command read-only over delivery-looking surrounding text", async () => {
    const requests: ExternalDAIRequest[] = [];
    const runtime = async (request: ExternalDAIRequest): Promise<DAIResponse> => {
      requests.push(request);
      return { taskId: "task-status", stage: "verify", environment: "codex", status: "accepted", evidence: [], message: "status" };
    };
    const activate = createCodexActivation(runtime);

    await activate({ rawCommand: "@D-AI status, then fix and create a PR", taskId: null });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.command).toEqual({ kind: "status" });
  });

  it("routes natural-language delivery to the thin orchestration seam", async () => {
    const deliveryRequests: string[] = [];
    const deliveryResult: DeliveryResult = {
      status: "completed",
      taskId: "task-delivery",
      intent: "delivery",
      riskLevel: 2,
      resumed: false,
      changes: ["src/automation/user-intent.ts"],
      focusedTest: "passed",
      typecheck: "passed",
      ci: "passed",
      platforms: { windows: "PASS", linux: "PASS" },
      publicationStatus: "PASS",
      branch: "codex/mvp",
      commit: "a".repeat(40),
      pr: "https://github.com/keida/D-AI-Hub/pull/31",
      mergePerformed: "NO",
      timings: {
        context_read_ms: 1,
        workspace_prepare_ms: 2,
        implementation_ms: 3,
        focused_test_ms: 4,
        publication_ms: 5,
        ci_wait_ms: 6,
        review_packet_ms: 7,
      },
      reviewPacket: "review-ready",
      decisionRequired: "Separate review and merge authorization are required",
      message: "Delivery completed",
      totalActiveExecutionMs: 28,
      blockedAt: null,
      reason: null,
      userAction: null,
    };
    const runtime = async (): Promise<DAIResponse> => { throw new Error("delivery should use orchestration seam"); };
    const activate = createCodexActivation(runtime, {
      deliver: async (request) => {
        deliveryRequests.push(`${request.taskId}:${request.resumeExistingTask}`);
        return deliveryResult;
      },
    });

    const result = await activate({ rawCommand: "修复健康检查并创建 PR", taskId: "task-delivery" });

    expect(deliveryRequests).toEqual(["task-delivery:false"]);
    expect(result).toMatchObject({ status: "completed", deliveryResult, userIntent: { intent: "delivery", expectedEndpoint: "review-ready-pr" } });
  });

  it("keeps natural-language delivery blocked when the orchestration seam is unavailable", async () => {
    const runtime = async (): Promise<DAIResponse> => { throw new Error("delivery must not fall through to the durable runtime"); };
    const activate = createCodexActivation(runtime);

    const result = await activate({ rawCommand: "fix the project and create a PR", taskId: null });

    expect(result).toMatchObject({ status: "blocked", userIntent: { intent: "delivery" } });
    expect(result.message).toMatch(/delivery orchestration.*publication authority/i);
  });
});
