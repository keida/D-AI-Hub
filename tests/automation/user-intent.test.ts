import { describe, expect, it } from "vitest";
import { classifyUserIntent } from "../../src/automation/user-intent.js";

describe("classifyUserIntent", () => {
  it.each([
    ["这个方案是不是应该改成 SQLite？", "discuss", "read-only", "discussion", null, false],
    ["这个方案怎么样？", "discuss", "read-only", "discussion", null, false],
    ["should we change to SQLite?", "discuss", "read-only", "discussion", null, false],
    ["what is a commit?", "discuss", "read-only", "discussion", null, false],
    ["explain publish/subscribe architecture", "discuss", "read-only", "discussion", null, false],
    ["explain the prefix handling", "discuss", "read-only", "discussion", null, false],
    ["review the exchange rate", "discuss", "read-only", "discussion", null, false],
    ["讨论一下这个方案", "discuss", "read-only", "discussion", null, false],
    ["检查一下当前状态", "status", "read-only", "status", null, false],
    ["what is the current status?", "status", "read-only", "status", null, false],
    ["how is the project status?", "status", "read-only", "status", null, false],
    ["what is D-AI-Hub progress?", "status", "read-only", "status", "D-AI-Hub", false],
    ["what is D-AI-Hub's status?", "status", "read-only", "status", "D-AI-Hub", false],
    ["现在 D-AI-Hub 进展怎么样？", "status", "read-only", "status", "D-AI-Hub", false],
    ["现在 D-AI-Hub 做到哪里了？", "status", "read-only", "status", "D-AI-Hub", false],
    ["现在 D-AI-Hub 做到哪了？", "status", "read-only", "status", "D-AI-Hub", false],
    ["继续上次 D-AI-Hub 的工作。", "continue", "bounded-mutation", "continuation", "D-AI-Hub", true],
    ["查看 D-AI-Hub 当前状态", "status", "read-only", "status", "D-AI-Hub", false],
    ["continue D-AI-Hub, fix the status check", "delivery", "bounded-mutation", "local-change", "D-AI-Hub", true],
    ["继续 D-AI-Hub", "continue", "bounded-mutation", "continuation", "D-AI-Hub", true],
    ["继续修复 D-AI-Hub 并创建 PR", "delivery", "bounded-mutation", "review-ready-pr", "D-AI-Hub", true],
    ["继续 D-AI-Hub，把这个小 bug 修好，测试以后提 PR。", "delivery", "bounded-mutation", "review-ready-pr", "D-AI-Hub", true],
    ["修复健康检查并创建 pull request", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["帮我把 memory export 的错误处理修掉，测试好以后提 PR。", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["那就改成 SQLite。", "delivery", "bounded-mutation", "local-change", null, false],
    ["那就按这个方案改。", "delivery", "bounded-mutation", "local-change", null, false],
    ["关闭当前任务", "close", "bounded-mutation", "close", null, false],
    ["今天先做到这里，把状态保存好。", "close", "bounded-mutation", "close", null, false],
    ["这个任务结束了，帮我收尾。", "close", "bounded-mutation", "close", null, false],
    ["回滚刚才的变更", "rollback", "destructive", "rollback", null, false],
    ["恢复之前状态", "rollback", "destructive", "rollback", null, false],
    ["刚才这次改动有问题，恢复到修改前。", "rollback", "destructive", "rollback", null, false],
    ["同步 canonical main", "sync", "external-read", "sync", null, false],
    ["在新环境建立 D-AI-Hub", "establish", "setup", "establish", "D-AI-Hub", false],
    ["please continue the lending project and fix the status check", "delivery", "bounded-mutation", "local-change", "lending project", true],
    ["publish this change", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["push this change", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["commit this change", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["commit and push this change", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["提交并推送这个修改", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["发布这个修改并提 PR", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["give me an update on D-AI-Hub", "status", "read-only", "status", "D-AI-Hub", false],
    ["update me about D-AI-Hub", "status", "read-only", "status", "D-AI-Hub", false],
    ["update me regarding D-AI-Hub", "status", "read-only", "status", "D-AI-Hub", false],
    ["update me on the project", "status", "read-only", "status", null, false],
    ["update the parser", "delivery", "bounded-mutation", "local-change", null, false],
    ["create a local parser", "delivery", "bounded-mutation", "local-change", null, false],
    ["创建一个 CLI helper", "delivery", "bounded-mutation", "local-change", null, false],
    ["explain commit and push semantics", "discuss", "read-only", "discussion", null, false],
    ["please explain commit and push semantics", "discuss", "read-only", "discussion", null, false],
    ["please explain the change", "discuss", "read-only", "discussion", null, false],
    ["please describe the update", "discuss", "read-only", "discussion", null, false],
    ["请解释这个修改", "discuss", "read-only", "discussion", null, false],
    ["请解释提交并推送这个修改的语义", "discuss", "read-only", "discussion", null, false],
    ["push", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["pull request", "delivery", "bounded-mutation", "review-ready-pr", null, false],
    ["推送分支", "delivery", "bounded-mutation", "review-ready-pr", null, false],
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

  it("maps the four explicit risk levels", () => {
    expect(classifyUserIntent("这个方案是不是应该改成 SQLite？").riskLevel).toBe(0);
    expect(classifyUserIntent("那就按这个方案改。").riskLevel).toBe(1);
    expect(classifyUserIntent("修复健康检查并创建 PR").riskLevel).toBe(2);
    expect(classifyUserIntent("恢复之前状态").riskLevel).toBe(3);
  });

  it("rejects non-string input", () => {
    expect(() => classifyUserIntent(null as unknown as string)).toThrow("user request must be a string");
  });
});
