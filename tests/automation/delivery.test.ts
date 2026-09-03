import { describe, expect, it } from "vitest";
import { createDeliveryOrchestrator, type DeliveryDependencies } from "../../src/automation/delivery.js";

function dependencies(events: string[]): DeliveryDependencies {
  return {
    readContext: async () => { events.push("context"); return { summary: "current project context" }; },
    prepareWorkspace: async () => { events.push("workspace"); return { branch: "codex/mvp", clean: true }; },
    implement: async () => { events.push("implementation"); return { changes: ["src/automation/user-intent.ts"] }; },
    runFocusedTest: async () => { events.push("focused-test"); return { status: "passed", detail: "14/14 passed" }; },
    runTypecheck: async () => { events.push("typecheck"); return { status: "passed", detail: "tsc --noEmit passed" }; },
    publish: async () => { events.push("publication"); return { branch: "codex/mvp", commit: "a".repeat(40), pr: "https://github.com/keida/D-AI-Hub/pull/31" }; },
    waitForCI: async () => { events.push("ci"); return { status: "passed", detail: "8/8 CI jobs passed", platforms: { windows: "PASS", linux: "PASS" } }; },
    buildReviewPacket: async () => { events.push("review-packet"); return "review-ready"; },
  };
}

describe("createDeliveryOrchestrator", () => {
  it("runs the bounded delivery stages in order and never merges", async () => {
    const events: string[] = [];
    const result = await createDeliveryOrchestrator(dependencies(events))({
      taskId: "task-delivery-1",
      project: "D-AI-Hub",
      requestText: "继续修复 D-AI-Hub 并创建 PR",
      resumeExistingTask: true,
      riskLevel: 2,
      publicationRequested: true,
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    });

    expect(events).toEqual(["context", "workspace", "implementation", "focused-test", "typecheck", "publication", "ci", "review-packet"]);
    expect(result).toMatchObject({
      status: "completed",
      taskId: "task-delivery-1",
      intent: "delivery",
      resumed: true,
      changes: ["src/automation/user-intent.ts"],
      focusedTest: "passed",
      typecheck: "passed",
      ci: "passed",
      riskLevel: 2,
      platforms: { windows: "PASS", linux: "PASS" },
      publicationStatus: "PASS",
      branch: "codex/mvp",
      commit: "a".repeat(40),
      pr: "https://github.com/keida/D-AI-Hub/pull/31",
      mergePerformed: "NO",
      reviewPacket: "review-ready",
    });
    expect(result.timings).toEqual(expect.objectContaining({
      context_read_ms: expect.any(Number),
      workspace_prepare_ms: expect.any(Number),
      implementation_ms: expect.any(Number),
      focused_test_ms: expect.any(Number),
      publication_ms: expect.any(Number),
      ci_wait_ms: expect.any(Number),
      review_packet_ms: expect.any(Number),
    }));
  });

  it("preserves asymmetric Windows and Linux CI observations", async () => {
    const events: string[] = [];
    const asymmetric: DeliveryDependencies = {
      ...dependencies(events),
      waitForCI: async () => { events.push("ci"); return { status: "failed", detail: "Windows failed; Linux passed", platforms: { windows: "FAIL", linux: "PASS" } }; },
    };
    const result = await createDeliveryOrchestrator(asymmetric)({
      taskId: "task-delivery-asymmetric",
      project: "D-AI-Hub",
      requestText: "fix the project and create a PR",
      resumeExistingTask: false,
      riskLevel: 2,
      publicationRequested: true,
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    });

    expect(result).toMatchObject({ status: "blocked", ci: "failed", platforms: { windows: "FAIL", linux: "PASS" } });
  });

  it("blocks before any delivery stage when publication authority is absent", async () => {
    const events: string[] = [];
    const result = await createDeliveryOrchestrator(dependencies(events))({
      taskId: "task-delivery-blocked",
      project: null,
      requestText: "fix the project and create a PR",
      resumeExistingTask: false,
      riskLevel: 2,
      publicationRequested: true,
      publicationAuthority: null,
    });

    expect(events).toEqual(["context", "workspace", "implementation", "focused-test", "typecheck", "review-packet"]);
    expect(result).toMatchObject({
      status: "blocked",
      mergePerformed: "NO",
      focusedTest: "passed",
      typecheck: "passed",
      changes: ["src/automation/user-intent.ts"],
      publicationStatus: "PENDING",
      decisionRequired: "Explicit publication authority is required before commit, push, or PR creation",
    });
    expect(result.timings).toEqual({
      context_read_ms: 0,
      workspace_prepare_ms: 0,
      implementation_ms: 0,
      focused_test_ms: 0,
      publication_ms: 0,
      ci_wait_ms: 0,
      review_packet_ms: 0,
    });
  });

  it("stops before publication when focused verification fails", async () => {
    const events: string[] = [];
    const failing: DeliveryDependencies = {
      ...dependencies(events),
      runFocusedTest: async () => { events.push("focused-test"); return { status: "failed", detail: "focused test failed" }; },
    };

    const result = await createDeliveryOrchestrator(failing)({
      taskId: "task-delivery-test-failure",
      project: "D-AI-Hub",
      requestText: "fix the project and create a PR",
      resumeExistingTask: false,
      riskLevel: 2,
      publicationRequested: true,
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    });

    expect(events).toEqual(["context", "workspace", "implementation", "focused-test"]);
    expect(result.status).toBe("blocked");
    expect(result.timings.publication_ms).toBe(0);
    expect(result.decisionRequired).toContain("focused verification");
  });

  it("stops before implementation when workspace preparation is not clean", async () => {
    const events: string[] = [];
    const dirtyWorkspace: DeliveryDependencies = {
      ...dependencies(events),
      prepareWorkspace: async () => { events.push("workspace"); return { branch: "codex/mvp", clean: false }; },
    };

    const result = await createDeliveryOrchestrator(dirtyWorkspace)({
      taskId: "task-delivery-dirty",
      project: "D-AI-Hub",
      requestText: "fix the project and create a PR",
      resumeExistingTask: false,
      riskLevel: 2,
      publicationRequested: true,
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    });

    expect(events).toEqual(["context", "workspace"]);
    expect(result).toMatchObject({
      status: "blocked",
      branch: "codex/mvp",
      decisionRequired: "Resolve unrelated workspace changes before implementation or publication",
      mergePerformed: "NO",
    });
  });

  it("completes a Level 1 local delivery without publication authority", async () => {
    const events: string[] = [];
    const result = await createDeliveryOrchestrator(dependencies(events))({
      taskId: "task-delivery-local",
      project: "D-AI-Hub",
      requestText: "那就改成 SQLite。",
      resumeExistingTask: false,
      riskLevel: 1,
      publicationRequested: false,
      publicationAuthority: null,
    });

    expect(events).toEqual(["context", "workspace", "implementation", "focused-test", "typecheck", "review-packet"]);
    expect(result).toMatchObject({ status: "completed", riskLevel: 1, publicationStatus: "PENDING", pr: null, mergePerformed: "NO" });
    expect(result.formatted).toContain("D-AI Delivery Result");
    expect(result.formatted).toContain("Focused test: PASSED");
    expect(result.formatted).toContain("Windows: PENDING");
    expect(result.formatted).toContain("Linux: PENDING");
    expect(result.formatted).toContain("Total active execution:");
    expect(result.formatted).toContain("Completed/Blocked: COMPLETED");
    expect(result.formatted).toContain("Merge performed: NO");
  });
});
