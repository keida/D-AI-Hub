import { describe, expect, it } from "vitest";
import {
  CapabilityMismatchError,
  CloseBlockedError,
  InvalidHandoffError,
  InvalidTaskStateError,
  UnsavedContextError,
  VerificationGateError,
} from "../../src/domain/errors.js";
import { assertStageTransition } from "../../src/domain/transitions.js";
import type { Stage } from "../../src/domain/types.js";

describe("assertStageTransition", () => {
  it.each<[Stage, Stage]>([
    ["bootstrap", "route"],
    ["route", "plan"],
    ["plan", "execute"],
    ["execute", "inspect"],
    ["inspect", "verify"],
    ["verify", "close"],
    ["verify", "debug"],
    ["debug", "recover"],
    ["recover", "execute"],
    ["execute", "handoff"],
    ["handoff", "execute"],
  ])("accepts %s to %s", (from, to) => {
    expect(() => assertStageTransition(from, to)).not.toThrow();
  });

  it("rejects execute to close", () => {
    expect(() => assertStageTransition("execute", "close")).toThrow(InvalidTaskStateError);
  });

  it("rejects unknown stages explicitly", () => {
    expect(() => assertStageTransition("unknown" as Stage, "route")).toThrow(InvalidTaskStateError);
    expect(() => assertStageTransition("bootstrap", "unknown" as Stage)).toThrow(InvalidTaskStateError);
  });
});

describe("domain error contracts", () => {
  it.each([
    InvalidTaskStateError,
    CapabilityMismatchError,
    InvalidHandoffError,
    VerificationGateError,
    UnsavedContextError,
    CloseBlockedError,
  ])("exposes %s as an Error", (ErrorType) => {
    expect(new ErrorType("contract test")).toBeInstanceOf(Error);
  });
});
