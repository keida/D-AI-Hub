import { describe, expect, it } from "vitest";
import { deriveProjectResultDisposition } from "../../src/project-owned/project-owned-reconciliation.js";

const result = (executionVerdict: "PASS" | "FAIL" | "BLOCKED", acceptanceVerdict: "ACCEPTED" | "REJECTED") => ({
  execution: { verdict: executionVerdict, scope: ["natural run", "published snapshot"] },
  acceptance: {
    verdict: acceptanceVerdict,
    authorityId: "project-boss",
    acceptedScope: ["historical evidence reviewed", "caveats retained"],
    acceptedAt: "2026-09-25T00:00:00.000Z",
  },
});

describe("deriveProjectResultDisposition", () => {
  it("marks a fully checked PASS+ACCEPTED handoff as verified but leaves close separate", () => {
    expect(deriveProjectResultDisposition(result("PASS", "ACCEPTED"))).toBe("HANDOFF_VERIFIED_AWAITING_CLOSE_DECISION");
  });

  it.each([
    ["FAIL", "ACCEPTED", "PROJECT_EXECUTION_FAILED"],
    ["BLOCKED", "ACCEPTED", "PROJECT_EXECUTION_BLOCKED"],
    ["PASS", "REJECTED", "PROJECT_RESULT_REJECTED"],
  ] as const)("keeps %s / %s distinct", (execution, acceptance, expected) => {
    expect(deriveProjectResultDisposition(result(execution, acceptance))).toBe(expected);
  });
});
