import { describe, expect, it } from "vitest";
import { CapabilityMismatchError, InvalidTaskStateError } from "../../src/domain/errors.js";
import type { Environment, Role, Stage } from "../../src/domain/types.js";
import { resolveModelRoute, type ModelPolicy, type RoutingOverrides } from "../../src/routing/model-router.js";

function policy(
  stage: Stage,
  role: Role,
  model: string,
  requiredCapabilities: readonly string[],
  compatibleEnvironments: readonly Environment[],
): ModelPolicy {
  return { stage, role, model, requiredCapabilities, compatibleEnvironments };
}

const noOverrides: RoutingOverrides = { model: null, role: null, environment: null };

describe("resolveModelRoute", () => {
  it("selects the exact default stage and role policy", () => {
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code", "verification"], ["codex"])];

    expect(resolveModelRoute("execute", "implementer", "codex", policies, noOverrides)).toEqual({
      stage: "execute",
      role: "implementer",
      environment: "codex",
      selectedModel: "gpt-5-codex",
      selectedCapabilities: ["code", "verification"],
      reason: "Default model policy selected gpt-5-codex for execute/implementer in codex.",
      overrideSource: "default",
    });
  });

  it("applies a model override before returning the matching policy", () => {
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code"], ["codex"])];
    const overrides: RoutingOverrides = { model: "gpt-5-codex", role: null, environment: null };

    expect(resolveModelRoute("execute", "implementer", "codex", policies, overrides)).toMatchObject({
      selectedModel: "gpt-5-codex",
      overrideSource: "user",
    });
  });

  it("applies a role override before policy matching", () => {
    const policies = [
      policy("inspect", "implementer", "gpt-5-codex", ["code"], ["codex"]),
      policy("inspect", "reviewer", "gpt-5-review", ["review"], ["codex"]),
    ];
    const overrides: RoutingOverrides = { model: null, role: "reviewer", environment: null };

    expect(resolveModelRoute("inspect", "implementer", "codex", policies, overrides)).toMatchObject({
      role: "reviewer",
      selectedModel: "gpt-5-review",
      overrideSource: "user",
    });
  });

  it("applies a compatible environment override before returning the decision", () => {
    const policies = [policy("verify", "evidence-collector", "gpt-5", ["verification"], ["codex", "work"])];
    const overrides: RoutingOverrides = { model: null, role: null, environment: "work" };

    expect(resolveModelRoute("verify", "evidence-collector", "codex", policies, overrides)).toMatchObject({
      environment: "work",
      overrideSource: "user",
    });
  });

  it("applies model, role, and environment overrides together", () => {
    const policies = [policy("plan", "planner", "gpt-5-planning", ["planning"], ["work"])];
    const overrides: RoutingOverrides = { model: "gpt-5-planning", role: "planner", environment: "work" };

    expect(resolveModelRoute("plan", "analyst", "chat", policies, overrides)).toEqual({
      stage: "plan",
      role: "planner",
      environment: "work",
      selectedModel: "gpt-5-planning",
      selectedCapabilities: ["planning"],
      reason: "User override selected gpt-5-planning for plan/planner in work.",
      overrideSource: "user",
    });
  });

  it("applies a stage override before policy matching", () => {
    const policies = [policy("verify", "implementer", "gpt-5-review", ["verification"], ["work"])];
    const overrides: RoutingOverrides = { model: null, role: null, environment: null, stage: "verify" };

    expect(resolveModelRoute("execute", "implementer", "work", policies, overrides)).toEqual({
      stage: "verify",
      role: "implementer",
      environment: "work",
      selectedModel: "gpt-5-review",
      selectedCapabilities: ["verification"],
      reason: "User override selected gpt-5-review for verify/implementer in work.",
      overrideSource: "user",
    });
  });

  it("rejects an unavailable model override instead of substituting a policy", () => {
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code"], ["codex"])];
    const overrides: RoutingOverrides = { model: "unavailable-model", role: null, environment: null };

    expect(() => resolveModelRoute("execute", "implementer", "codex", policies, overrides)).toThrow(CapabilityMismatchError);
    expect(() => resolveModelRoute("execute", "implementer", "codex", policies, overrides)).toThrowError(
      "No model policy can satisfy stage=execute, role=implementer, environment=codex, model=unavailable-model.",
    );
  });

  it("rejects a missing stage and role policy", () => {
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code"], ["codex"])];

    expect(() => resolveModelRoute("verify", "reviewer", "codex", policies, noOverrides)).toThrow(CapabilityMismatchError);
  });

  it("selects a deterministic default and supports an exact alternative model override", () => {
    const policies = [
      policy("execute", "implementer", "gpt-5-codex", ["code"], ["codex"]),
      policy("execute", "implementer", "gpt-5-alt", ["code"], ["codex"]),
    ];

    expect(resolveModelRoute("execute", "implementer", "codex", policies, noOverrides).selectedModel).toBe("gpt-5-alt");
    expect(
      resolveModelRoute("execute", "implementer", "codex", [...policies].reverse(), noOverrides).selectedModel,
    ).toBe("gpt-5-alt");
    expect(
      resolveModelRoute("execute", "implementer", "codex", policies, {
        model: "gpt-5-codex",
        role: null,
        environment: null,
      }).selectedModel,
    ).toBe("gpt-5-codex");
  });

  it("rejects duplicate policies with the same stage, role, and model", () => {
    const policies = [
      policy("execute", "implementer", "gpt-5-codex", ["code"], ["codex"]),
      policy("execute", "implementer", "gpt-5-codex", ["code"], ["codex"]),
    ];

    expect(() => resolveModelRoute("execute", "implementer", "codex", policies, noOverrides)).toThrowError(
      "Duplicate model policy declaration for stage=execute, role=implementer, model=gpt-5-codex.",
    );
  });

  it("rejects an incompatible environment override", () => {
    const policies = [policy("verify", "evidence-collector", "gpt-5", ["verification"], ["work"])];

    expect(() =>
      resolveModelRoute("verify", "evidence-collector", "work", policies, {
        model: null,
        role: null,
        environment: "codex",
      }),
    ).toThrowError(
      "Model policy for stage=verify, role=evidence-collector, model=gpt-5 is incompatible with environment=codex.",
    );
  });

  it("rejects a policy that cannot support the current environment", () => {
    const policies = [policy("verify", "evidence-collector", "gpt-5", ["verification"], ["work"])];

    expect(() => resolveModelRoute("verify", "evidence-collector", "codex", policies, noOverrides)).toThrow(
      CapabilityMismatchError,
    );
  });

  it("copies required capabilities from the selected policy", () => {
    const requiredCapabilities = ["verification", "evidence"];
    const policies = [policy("verify", "evidence-collector", "gpt-5", requiredCapabilities, ["work"])];
    const result = resolveModelRoute("verify", "evidence-collector", "work", policies, noOverrides);

    expect(result.selectedCapabilities).toEqual(["verification", "evidence"]);
    expect(result.selectedCapabilities).not.toBe(requiredCapabilities);
    expect(requiredCapabilities).toEqual(["verification", "evidence"]);
  });

  it.each([
    ["invalid stage", "invalid-stage" as never, "implementer", "codex", [], noOverrides, "Invalid stage: invalid-stage."],
    ["invalid role", "execute", "invalid-role" as never, "codex", [], noOverrides, "Invalid role: invalid-role."],
    ["invalid environment", "execute", "implementer", "invalid-environment" as never, [], noOverrides, "Invalid environment: invalid-environment."],
    ["non-array policies", "execute", "implementer", "codex", null as never, noOverrides, "Model policies must be an array."],
    ["null policy", "execute", "implementer", "codex", [null as never], noOverrides, "Model policy at index=0 must be an object."],
    [
      "non-array capabilities",
      "execute",
      "implementer",
      "codex",
      [{ stage: "execute", role: "implementer", model: "gpt-5", requiredCapabilities: null, compatibleEnvironments: ["codex"] } as never],
      noOverrides,
      "Model policy at index=0 must declare requiredCapabilities as an array.",
    ],
    [
      "non-array environments",
      "execute",
      "implementer",
      "codex",
      [{ stage: "execute", role: "implementer", model: "gpt-5", requiredCapabilities: [], compatibleEnvironments: null } as never],
      noOverrides,
      "Model policy at index=0 must declare compatibleEnvironments as an array.",
    ],
    [
      "invalid policy stage",
      "execute",
      "implementer",
      "codex",
      [{ stage: "invalid-stage", role: "implementer", model: "gpt-5", requiredCapabilities: [], compatibleEnvironments: ["codex"] } as never],
      noOverrides,
      "Invalid stage: invalid-stage.",
    ],
    [
      "invalid policy role",
      "execute",
      "implementer",
      "codex",
      [{ stage: "execute", role: "invalid-role", model: "gpt-5", requiredCapabilities: [], compatibleEnvironments: ["codex"] } as never],
      noOverrides,
      "Invalid role: invalid-role.",
    ],
    [
      "malformed capability array",
      "execute",
      "implementer",
      "codex",
      [{ stage: "execute", role: "implementer", model: "gpt-5", requiredCapabilities: [null], compatibleEnvironments: ["codex"] } as never],
      noOverrides,
      "Model policy at index=0 has an invalid requiredCapabilities value.",
    ],
    [
      "empty model",
      "execute",
      "implementer",
      "codex",
      [{ stage: "execute", role: "implementer", model: "", requiredCapabilities: [], compatibleEnvironments: ["codex"] } as never],
      noOverrides,
      "Model policy at index=0 must declare a non-empty model.",
    ],
    [
      "invalid compatible environment",
      "execute",
      "implementer",
      "codex",
      [{ stage: "execute", role: "implementer", model: "gpt-5", requiredCapabilities: [], compatibleEnvironments: ["desktop"] } as never],
      noOverrides,
      "Model policy at index=0 has an invalid compatible environment: desktop.",
    ],
    ["null overrides", "execute", "implementer", "codex", [], null as never, "Routing overrides must be an object."],
    [
      "invalid override model",
      "execute",
      "implementer",
      "codex",
      [],
      { model: "", role: null, environment: null } as never,
      "Routing override model must be null or a non-empty string.",
    ],
    [
      "invalid override role",
      "execute",
      "implementer",
      "codex",
      [],
      { model: null, role: "invalid-role", environment: null } as never,
      "Routing override role must be null or a known role.",
    ],
    [
      "invalid override environment",
      "execute",
      "implementer",
      "codex",
      [],
      { model: null, role: null, environment: ["codex"] } as never,
      "Routing override environment must be null or a known environment.",
    ],
  ])("rejects %s at the routing boundary", (_name, stage, role, environment, policies, overrides, expectedMessage) => {
    expect(() =>
      resolveModelRoute(
        stage as Stage,
        role as Role,
        environment as Environment,
        policies as readonly ModelPolicy[],
        overrides as RoutingOverrides,
      ),
    ).toThrow(InvalidTaskStateError);
    expect(() =>
      resolveModelRoute(
        stage as Stage,
        role as Role,
        environment as Environment,
        policies as readonly ModelPolicy[],
        overrides as RoutingOverrides,
      ),
    ).toThrowError(expectedMessage);
  });
});
