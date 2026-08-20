import { describe, expect, it } from "vitest";
import { CapabilityMismatchError } from "../../src/domain/errors.js";
import type { Environment, Role, Stage } from "../../src/domain/types.js";
import { resolveModelRoute, type ModelPolicy, type RoutingOverrides } from "../../src/routing/model-router.js";

function policy(
  stage: Stage,
  role: Role,
  model: string,
  requiredCapabilities: readonly string[],
): ModelPolicy {
  return { stage, role, model, requiredCapabilities };
}

const noOverrides: RoutingOverrides = { model: null, role: null, environment: null };

describe("resolveModelRoute", () => {
  it("selects the exact default stage and role policy", () => {
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code", "verification"])];

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
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code"])];
    const overrides: RoutingOverrides = { model: "gpt-5-codex", role: null, environment: null };

    expect(resolveModelRoute("execute", "implementer", "codex", policies, overrides)).toMatchObject({
      selectedModel: "gpt-5-codex",
      overrideSource: "user",
    });
  });

  it("applies a role override before policy matching", () => {
    const policies = [
      policy("inspect", "implementer", "gpt-5-codex", ["code"]),
      policy("inspect", "reviewer", "gpt-5-review", ["review"]),
    ];
    const overrides: RoutingOverrides = { model: null, role: "reviewer", environment: null };

    expect(resolveModelRoute("inspect", "implementer", "codex", policies, overrides)).toMatchObject({
      role: "reviewer",
      selectedModel: "gpt-5-review",
      overrideSource: "user",
    });
  });

  it("applies an environment override before returning the decision", () => {
    const policies = [policy("verify", "evidence-collector", "gpt-5", ["verification"])];
    const overrides: RoutingOverrides = { model: null, role: null, environment: "work" };

    expect(resolveModelRoute("verify", "evidence-collector", "codex", policies, overrides)).toMatchObject({
      environment: "work",
      overrideSource: "user",
    });
  });

  it("applies model, role, and environment overrides together", () => {
    const policies = [policy("plan", "planner", "gpt-5-planning", ["planning"])];
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

  it("rejects an unavailable model override instead of substituting a policy", () => {
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code"])];
    const overrides: RoutingOverrides = { model: "unavailable-model", role: null, environment: null };

    expect(() => resolveModelRoute("execute", "implementer", "codex", policies, overrides)).toThrow(CapabilityMismatchError);
    expect(() => resolveModelRoute("execute", "implementer", "codex", policies, overrides)).toThrowError(
      "No model policy can satisfy stage=execute, role=implementer, environment=codex, model=unavailable-model.",
    );
  });

  it("rejects a missing stage and role policy", () => {
    const policies = [policy("execute", "implementer", "gpt-5-codex", ["code"])];

    expect(() => resolveModelRoute("verify", "reviewer", "codex", policies, noOverrides)).toThrow(CapabilityMismatchError);
  });

  it("rejects duplicate policies rather than choosing by declaration order", () => {
    const policies = [
      policy("execute", "implementer", "gpt-5-codex", ["code"]),
      policy("execute", "implementer", "gpt-5-alt", ["code"]),
    ];

    expect(() => resolveModelRoute("execute", "implementer", "codex", policies, noOverrides)).toThrow(CapabilityMismatchError);
    expect(() => resolveModelRoute("execute", "implementer", "codex", policies, noOverrides)).toThrowError(
      "Duplicate model policy declaration for stage=execute, role=implementer.",
    );
  });

  it("copies required capabilities from the selected policy", () => {
    const requiredCapabilities = ["verification", "evidence"];
    const policies = [policy("verify", "evidence-collector", "gpt-5", requiredCapabilities)];
    const result = resolveModelRoute("verify", "evidence-collector", "work", policies, noOverrides);

    expect(result.selectedCapabilities).toEqual(["verification", "evidence"]);
    expect(result.selectedCapabilities).not.toBe(requiredCapabilities);
    expect(requiredCapabilities).toEqual(["verification", "evidence"]);
  });
});
