import { describe, expect, it } from "vitest";
import { classifyUserIntent } from "../../src/automation/user-intent.js";

describe("classifyUserIntent", () => {
  it.each([
    ["这个方案是不是应该改成 SQLite？", "discuss", "read-only", "discussion", null, false],
    ["讨论一下这个方案", "discuss", "read-only", "discussion", null, false],
    ["检查一下当前状态", "status", "read-only", "status", null, false],
    ["现在 D-AI-Hub 做到哪里了？", "status", "read-only", "status", "D-AI-Hub", false],
    ["查看 D-AI-Hub 当前状态", "status", "read-only", "status", "D-AI-Hub", false],
    ["continue D-AI-Hub, fix the status check", "delivery", "bounded-mutation", "local-change", "D-AI-Hub", true],
    ["继续 D-AI-Hub", "continue", "bounded-mutation", "continuation", "D-AI-Hub", true],
    ["继续修复 D-AI-Hub 并创建 PR", "delivery", "bounded-mutation", "review-ready-pr", "D-AI-Hub", true],
    ["修复健康检查并创建 pull request", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["那就改成 SQLite。", "delivery", "bounded-mutation", "local-change", null, false],
    ["关闭当前任务", "close", "bounded-mutation", "close", null, false],
    ["今天先做到这里，把状态保存好。", "close", "bounded-mutation", "close", null, false],
    ["这个任务结束了，帮我收尾。", "close", "bounded-mutation", "close", null, false],
    ["回滚刚才的变更", "rollback", "destructive", "rollback", null, false],
    ["恢复之前状态", "rollback", "destructive", "rollback", null, false],
    ["同步 canonical main", "sync", "external-read", "sync", null, false],
    ["在新环境建立 D-AI-Hub", "establish", "setup", "establish", "D-AI-Hub", false],
    ["please continue the lending project and fix the status check", "delivery", "bounded-mutation", "local-change", "lending project", true],
  ] as const)("recognizes %s", (text, intent, risk, expectedEndpoint, project, resumeExistingTask) => {
    expect(classifyUserIntent(text)).toMatchObject({
      intent,
      risk,
      expectedEndpoint,
      project,
      resumeExistingTask,
    });
  });

  it("fails ambiguous requests into read-only discussion", () => {
    expect(classifyUserIntent("帮我看看这个方案")).toMatchObject({
      intent: "discuss",
      risk: "read-only",
      expectedEndpoint: "discussion",
    });
  });

  it("rejects non-string input", () => {
    expect(() => classifyUserIntent(null as unknown as string)).toThrow("user request must be a string");
  });
});
