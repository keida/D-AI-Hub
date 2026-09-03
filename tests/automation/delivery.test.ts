import { describe, expect, it } from "vitest";
import { createDeliveryOrchestrator, type DeliveryDependencies, type DeliveryRequest } from "../../src/automation/delivery.js";

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
      expectedEndpoint: "review-ready-pr",
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
    expect(result.agentExecutionDirective).toBeUndefined();
    expect(result.timings).toEqual(expect.objectContaining({
      context_read_ms: expect.any(Number),
      workspace_prepare_ms: expect.any(Number),
      implementation_ms: expect.any(Number),
      typecheck_ms: expect.any(Number),
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
      expectedEndpoint: "review-ready-pr",
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    });

    expect(result).toMatchObject({ status: "blocked", ci: "failed", platforms: { windows: "FAIL", linux: "PASS" } });
    expect(result.blockedAt).toBe("ci-wait");
    expect(result.agentExecutionDirective).toBeUndefined();
  });

  it("preserves passing platform evidence and rejects contradictory aggregate CI", async () => {
    const request: DeliveryRequest = {
      taskId: "task-delivery-platforms",
      project: "D-AI-Hub",
      requestText: "fix the project and create a PR",
      resumeExistingTask: false,
      riskLevel: 2,
      publicationRequested: true,
      expectedEndpoint: "review-ready-pr",
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    };
    const passing = await createDeliveryOrchestrator(dependencies([]))(request);
    expect(passing).toMatchObject({ status: "completed", ci: "passed", platforms: { windows: "PASS", linux: "PASS" } });

    const contradictory: DeliveryDependencies = {
      ...dependencies([]),
      waitForCI: async () => ({ status: "passed", detail: "aggregate passed", platforms: { windows: "PASS", linux: "PENDING" } }),
    };
    const result = await createDeliveryOrchestrator(contradictory)(request);
    expect(result).toMatchObject({ status: "blocked", ci: "failed", platforms: { windows: "PASS", linux: "PENDING" }, blockedAt: "ci-wait" });
    expect(result.agentExecutionDirective).toBeUndefined();
  });

  it("blocks at publication authority after preserving local verification", async () => {
    const events: string[] = [];
    const result = await createDeliveryOrchestrator(dependencies(events))({
      taskId: "task-delivery-blocked",
      project: null,
      requestText: "fix the project and create a PR",
      resumeExistingTask: false,
      riskLevel: 2,
      publicationRequested: true,
      expectedEndpoint: "review-ready-pr",
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
      blockedAt: "publication-authority",
      decisionRequired: "Explicit publication authority is required before commit, push, or PR creation",
    });
    expect(result.agentExecutionDirective).toBeUndefined();
    expect(result.timings).toEqual(expect.objectContaining({
      context_read_ms: expect.any(Number),
      workspace_prepare_ms: expect.any(Number),
      implementation_ms: expect.any(Number),
      typecheck_ms: expect.any(Number),
      focused_test_ms: expect.any(Number),
      publication_ms: 0,
      ci_wait_ms: 0,
      review_packet_ms: expect.any(Number),
    }));
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
      expectedEndpoint: "review-ready-pr",
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    });

    expect(events).toEqual(["context", "workspace", "implementation", "focused-test"]);
    expect(result.status).toBe("blocked");
    expect(result.blockedAt).toBe("focused-test");
    expect(result.timings.publication_ms).toBe(0);
    expect(result.decisionRequired).toContain("focused verification");
    expect(result.agentExecutionDirective).toBeUndefined();
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
      expectedEndpoint: "review-ready-pr",
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    });

    expect(events).toEqual(["context", "workspace"]);
    expect(result).toMatchObject({
      status: "blocked",
      branch: "codex/mvp",
      blockedAt: "workspace-prepare",
      decisionRequired: "Resolve unrelated workspace changes before implementation or publication",
      mergePerformed: "NO",
    });
    expect(result.agentExecutionDirective).toBeUndefined();
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
      expectedEndpoint: "local-change",
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

  it("returns a precise blocked stage when a dependency throws", async () => {
    const request: DeliveryRequest = {
      taskId: "task-delivery-error",
      project: "D-AI-Hub",
      requestText: "fix the project and create a PR",
      resumeExistingTask: false,
      riskLevel: 2,
      publicationRequested: true,
      expectedEndpoint: "review-ready-pr",
      publicationAuthority: { grantedBy: "user", allowCommit: true, allowPush: true, allowCreatePR: true },
    };
    const scenarios: Array<[string, Partial<DeliveryDependencies>, string]> = [
      ["context", { readContext: async () => { throw new Error("context unavailable"); } }, "context-read"],
      ["implementation", { implement: async () => { throw new Error("implementation unavailable"); } }, "implementation"],
      ["typecheck", { runTypecheck: async () => { throw new Error("typecheck unavailable"); } }, "typecheck"],
      ["publication", { publish: async () => { throw new Error("publication unavailable"); } }, "publication"],
      ["ci", { waitForCI: async () => { throw new Error("CI unavailable"); } }, "ci-wait"],
      ["review packet", { buildReviewPacket: async () => { throw new Error("review packet unavailable"); } }, "review-packet"],
    ];

    for (const [name, override, blockedAt] of scenarios) {
      const result = await createDeliveryOrchestrator({ ...dependencies([]), ...override })(request);
      expect(result.status, name).toBe("blocked");
      expect(result.blockedAt, name).toBe(blockedAt);
    }
  });

  it("keeps the final review-packet timing authoritative after packet construction", async () => {
    const observed: Array<{ reviewPacketMs: number; totalActiveExecutionMs: number }> = [];
    const result = await createDeliveryOrchestrator({
      ...dependencies([]),
      buildReviewPacket: async (_request, preFinalResult) => {
        observed.push({
          reviewPacketMs: preFinalResult.timings.review_packet_ms,
          totalActiveExecutionMs: preFinalResult.totalActiveExecutionMs,
        });
        return "review-ready";
      },
    })({
      taskId: "task-delivery-review-timing",
      project: "D-AI-Hub",
      requestText: "那就按这个方案改。",
      resumeExistingTask: false,
      riskLevel: 1,
      publicationRequested: false,
      expectedEndpoint: "local-change",
    });

    expect(observed).toEqual([{ reviewPacketMs: 0, totalActiveExecutionMs: 0 }]);
    expect(result.formatted).toContain(`Total active execution: ${result.totalActiveExecutionMs}ms`);
  });
});
