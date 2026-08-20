import { describe, expect, it } from "vitest";

describe("debug session", () => {
  it("rejects a change before a hypothesis is recorded", async () => {
    const { advanceDebugSession, createDebugSession } = await import("../../src/debugging/debug-session.js");
    const reproduced = advanceDebugSession(createDebugSession("Build exits 1", "recovery-1"));
    const captured = advanceDebugSession(reproduced);
    const session = advanceDebugSession(captured);

    expect(() => advanceDebugSession(session)).toThrow(/hypothesis.*before change/i);
  });

  it("returns repeated verification failures to hypothesis with an actionable reason", async () => {
    const { advanceDebugSession, createDebugSession, recordRepeatedFailure, setDebugHypothesis } = await import("../../src/debugging/debug-session.js");
    const reproduced = advanceDebugSession(createDebugSession("Build exits 1", "recovery-1"));
    const captured = advanceDebugSession(reproduced);
    const isolated = advanceDebugSession(captured);
    const hypothesized = setDebugHypothesis(isolated, "The manifest is missing");
    const changed = advanceDebugSession(hypothesized);
    const reverifying = advanceDebugSession(changed);
    const result = recordRepeatedFailure(reverifying, "The build still exits 1");

    expect(result).toEqual({
      session: expect.objectContaining({ phase: "hypothesize", hypothesis: null }),
      reason: "The build still exits 1",
    });
  });
});
