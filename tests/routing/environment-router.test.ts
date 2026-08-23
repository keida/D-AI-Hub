import { describe, expect, it } from "vitest";
import { CapabilityMismatchError, CloseBlockedError, InvalidTaskStateError } from "../../src/domain/errors.js";
import { selectEnvironment } from "../../src/routing/environment-router.js";
import type { EnvironmentCapabilities } from "../../src/routing/environment-capabilities.js";
import type { Environment, Stage } from "../../src/domain/types.js";

function environment(environment: Environment, capabilities: readonly string[]): EnvironmentCapabilities {
  return { environment, capabilities: new Set(capabilities) };
}

function route(stage: Stage, available: readonly EnvironmentCapabilities[], requiredCapabilities: readonly string[]) {
  return selectEnvironment({ stage, requiredCapabilities, available, userEnvironmentOverride: null });
}

describe("selectEnvironment", () => {
  it.each<[Stage, Environment]>([
    ["bootstrap", "chat"],
    ["route", "chat"],
    ["plan", "chat"],
    ["execute", "work"],
    ["inspect", "work"],
    ["verify", "work"],
    ["debug", "codex"],
    ["recover", "codex"],
    ["handoff", "chat"],
  ])("selects %s's first compatible default environment", (stage, expectedEnvironment) => {
    const requiredCapabilities = ["stage-routing"];

    const result = route(stage, [
      environment("chat", ["stage-routing"]),
      environment("work", ["stage-routing"]),
      environment("codex", ["stage-routing"]),
    ], requiredCapabilities);

    expect(result).toEqual({
      environment: expectedEnvironment,
      reason: `Default ${stage} routing selected ${expectedEnvironment}.`,
      requiredCapabilities,
    });
  });

  it("falls through the default order when the preferred environment lacks a capability", () => {
    expect(
      route("execute", [environment("work", ["durable-context"]), environment("codex", ["local-execution"])], [
        "local-execution",
      ]),
    ).toMatchObject({ environment: "codex" });
  });

  it("preserves requested capability values without mutating the input", () => {
    const requiredCapabilities = ["approval", "status"];

    const result = route("route", [environment("chat", requiredCapabilities)], requiredCapabilities);

    expect(result.requiredCapabilities).toEqual(["approval", "status"]);
    expect(requiredCapabilities).toEqual(["approval", "status"]);
  });

  it("rejects duplicate environment declarations before routing", () => {
    expect(() =>
      route(
        "execute",
        [environment("work", ["local-execution"]), environment("work", ["local-execution"])],
        ["local-execution"],
      ),
    ).toThrowError("Duplicate environment declaration: work");
  });

  it("rejects unknown environment declarations before routing", () => {
    const unknownEnvironment = environment("chat", ["stage-routing"]);
    Object.defineProperty(unknownEnvironment, "environment", { value: "unknown" });

    expect(() => route("route", [unknownEnvironment, environment("chat", ["stage-routing"])], ["stage-routing"])).toThrowError(
      "Unknown environment declaration: unknown",
    );
  });

  it("rejects malformed environment capability collections before routing", () => {
    const malformedCapabilities = environment("chat", []);
    Object.defineProperty(malformedCapabilities, "capabilities", { value: ["stage-routing"] });

    expect(() => route("route", [malformedCapabilities], ["stage-routing"])).toThrow(CapabilityMismatchError);
    expect(() => route("route", [malformedCapabilities], ["stage-routing"])).toThrowError(
      "Environment chat must declare capabilities as a ReadonlySet-compatible collection",
    );
  });

  it("rejects capability collections with non-string values before routing", () => {
    const malformedCapabilities = environment("chat", []);
    Object.defineProperty(malformedCapabilities, "capabilities", { value: new Set([1]) });

    expect(() => route("route", [malformedCapabilities], ["stage-routing"])).toThrow(CapabilityMismatchError);
    expect(() => route("route", [malformedCapabilities], ["stage-routing"])).toThrowError(
      "Environment chat must declare capabilities as a ReadonlySet-compatible collection",
    );
  });

  it("rejects a route when no default environment covers the required capabilities", () => {
    expect(() => route("plan", [environment("chat", ["approval"]), environment("work", ["durable-context"])], ["local-execution"])).toThrow(
      CapabilityMismatchError,
    );
  });

  it("rejects a user override that is unavailable", () => {
    expect(() =>
      selectEnvironment({
        stage: "execute",
        requiredCapabilities: ["local-execution"],
        available: [environment("work", ["local-execution"])],
        userEnvironmentOverride: "codex",
      }),
    ).toThrow(CapabilityMismatchError);
  });

  it("rejects a user override that lacks a required capability", () => {
    expect(() =>
      selectEnvironment({
        stage: "execute",
        requiredCapabilities: ["local-execution"],
        available: [environment("work", ["durable-context"]), environment("codex", ["local-execution"])],
        userEnvironmentOverride: "work",
      }),
    ).toThrow(CapabilityMismatchError);
  });

  it("uses a compatible user override before the default policy", () => {
    const result = selectEnvironment({
      stage: "execute",
      requiredCapabilities: ["local-execution"],
      available: [environment("work", ["local-execution"]), environment("codex", ["local-execution"])],
      userEnvironmentOverride: "codex",
    });

    expect(result).toEqual({
      environment: "codex",
      reason: "User override selected codex for execute.",
      requiredCapabilities: ["local-execution"],
    });
  });

  it("routes close through Work only when durable context and Codex evidence are available", () => {
    const result = route("close", [
      environment("work", ["durable-context", "close-coordination"]),
      environment("codex", ["codex-evidence"]),
    ], ["close-coordination"]);

    expect(result).toEqual({
      environment: "work",
      reason: "Default close routing selected work after validating durable context and Codex evidence.",
      requiredCapabilities: ["close-coordination"],
    });
  });

  it("blocks close when Work lacks durable context", () => {
    expect(() => route("close", [environment("work", []), environment("codex", ["codex-evidence"])], [])).toThrow(
      CloseBlockedError,
    );
  });

  it("blocks close when Codex evidence is unavailable", () => {
    expect(() => route("close", [environment("work", ["durable-context"]), environment("codex", [])], [])).toThrow(
      CloseBlockedError,
    );
  });

  it("rejects unsupported stages explicitly", () => {
    expect(() => route("unsupported" as Stage, [environment("chat", [])], [])).toThrow(InvalidTaskStateError);
  });
});
