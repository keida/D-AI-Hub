import { CapabilityMismatchError } from "../domain/errors.js";
import type { Environment, Role, RoutingDecision, Stage } from "../domain/types.js";
import type { RoutingOverrides } from "./override-parser.js";

export type { RoutingOverrides } from "./override-parser.js";

export interface ModelPolicy {
  readonly stage: Stage;
  readonly role: Role;
  readonly model: string;
  readonly requiredCapabilities: readonly string[];
}

function assertUniquePolicies(policies: readonly ModelPolicy[]): void {
  const keys = new Set<string>();

  for (const policy of policies) {
    const key = `${policy.stage}:${policy.role}`;
    if (keys.has(key)) {
      throw new CapabilityMismatchError(
        `Duplicate model policy declaration for stage=${policy.stage}, role=${policy.role}.`,
      );
    }
    keys.add(key);
  }
}

function selectedRole(role: Role, overrides: RoutingOverrides): Role {
  return overrides.role ?? role;
}

function selectedEnvironment(environment: Environment, overrides: RoutingOverrides): Environment {
  return overrides.environment ?? environment;
}

function findPolicy(
  stage: Stage,
  role: Role,
  model: string | null,
  policies: readonly ModelPolicy[],
): ModelPolicy | undefined {
  return policies.find(
    (policy) => policy.stage === stage && policy.role === role && (model === null || policy.model === model),
  );
}

function requestedModel(model: string | null): string {
  return model ?? "default";
}

export function resolveModelRoute(
  stage: Stage,
  role: Role,
  environment: Environment,
  policies: readonly ModelPolicy[],
  overrides: RoutingOverrides,
): RoutingDecision {
  assertUniquePolicies(policies);
  const routedRole = selectedRole(role, overrides);
  const routedEnvironment = selectedEnvironment(environment, overrides);
  const policy = findPolicy(stage, routedRole, overrides.model, policies);

  if (policy === undefined) {
    throw new CapabilityMismatchError(
      `No model policy can satisfy stage=${stage}, role=${routedRole}, environment=${routedEnvironment}, model=${requestedModel(overrides.model)}.`,
    );
  }

  const overrideSource =
    overrides.model === null && overrides.role === null && overrides.environment === null ? "default" : "user";
  const reason =
    overrideSource === "user"
      ? `User override selected ${policy.model} for ${stage}/${routedRole} in ${routedEnvironment}.`
      : `Default model policy selected ${policy.model} for ${stage}/${routedRole} in ${routedEnvironment}.`;

  return {
    stage,
    role: routedRole,
    environment: routedEnvironment,
    selectedModel: policy.model,
    selectedCapabilities: [...policy.requiredCapabilities],
    reason,
    overrideSource,
  };
}
