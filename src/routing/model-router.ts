import { CapabilityMismatchError, InvalidTaskStateError } from "../domain/errors.js";
import type { Environment, Role, RoutingDecision, Stage } from "../domain/types.js";
import type { RoutingOverrides } from "./override-parser.js";

export type { RoutingOverrides } from "./override-parser.js";

export interface ModelPolicy {
  readonly stage: Stage;
  readonly role: Role;
  readonly model: string;
  readonly requiredCapabilities: readonly string[];
  readonly compatibleEnvironments: readonly Environment[];
}

const stages: ReadonlySet<string> = new Set([
  "bootstrap",
  "route",
  "plan",
  "execute",
  "inspect",
  "verify",
  "debug",
  "recover",
  "handoff",
  "close",
]);

const roles: ReadonlySet<string> = new Set([
  "analyst",
  "planner",
  "implementer",
  "evidence-collector",
  "reviewer",
  "debugger",
  "recovery-operator",
]);

const environments: ReadonlySet<string> = new Set(["chat", "work", "codex"]);

function assertStage(stage: Stage): void {
  if (!stages.has(stage)) {
    throw new InvalidTaskStateError(`Invalid stage: ${stage}.`);
  }
}

function assertRole(role: Role): void {
  if (!roles.has(role)) {
    throw new InvalidTaskStateError(`Invalid role: ${role}.`);
  }
}

function assertEnvironment(environment: Environment): void {
  if (!environments.has(environment)) {
    throw new InvalidTaskStateError(`Invalid environment: ${environment}.`);
  }
}

function assertStringArray(values: readonly string[], field: string, index: number): void {
  if (!Array.isArray(values)) {
    throw new InvalidTaskStateError(`Model policy at index=${index} must declare ${field} as an array.`);
  }

  for (const value of values) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new InvalidTaskStateError(`Model policy at index=${index} has an invalid ${field} value.`);
    }
  }
}

function assertPolicy(policy: ModelPolicy, index: number): void {
  if (policy === null || typeof policy !== "object") {
    throw new InvalidTaskStateError(`Model policy at index=${index} must be an object.`);
  }
  assertStage(policy.stage);
  assertRole(policy.role);
  if (typeof policy.model !== "string" || policy.model.trim().length === 0) {
    throw new InvalidTaskStateError(`Model policy at index=${index} must declare a non-empty model.`);
  }
  assertStringArray(policy.requiredCapabilities, "requiredCapabilities", index);
  assertStringArray(policy.compatibleEnvironments, "compatibleEnvironments", index);
  if (policy.compatibleEnvironments.length === 0) {
    throw new InvalidTaskStateError(`Model policy at index=${index} must declare a compatible environment.`);
  }
  for (const compatibleEnvironment of policy.compatibleEnvironments) {
    if (!environments.has(compatibleEnvironment)) {
      throw new InvalidTaskStateError(
        `Model policy at index=${index} has an invalid compatible environment: ${compatibleEnvironment}.`,
      );
    }
  }
}

function assertUniquePolicies(policies: readonly ModelPolicy[]): void {
  if (!Array.isArray(policies)) {
    throw new InvalidTaskStateError("Model policies must be an array.");
  }
  const keys = new Set<string>();

  for (const [index, policy] of policies.entries()) {
    assertPolicy(policy, index);
    const key = `${policy.stage}:${policy.role}:${policy.model}`;
    if (keys.has(key)) {
      throw new CapabilityMismatchError(
        `Duplicate model policy declaration for stage=${policy.stage}, role=${policy.role}, model=${policy.model}.`,
      );
    }
    keys.add(key);
  }
}

function assertOverrides(overrides: RoutingOverrides): void {
  if (overrides === null || typeof overrides !== "object") {
    throw new InvalidTaskStateError("Routing overrides must be an object.");
  }
  if (overrides.model !== null && (typeof overrides.model !== "string" || overrides.model.trim().length === 0)) {
    throw new InvalidTaskStateError("Routing override model must be null or a non-empty string.");
  }
  if (overrides.role !== null && !roles.has(overrides.role)) {
    throw new InvalidTaskStateError("Routing override role must be null or a known role.");
  }
  if (overrides.environment !== null && !environments.has(overrides.environment)) {
    throw new InvalidTaskStateError("Routing override environment must be null or a known environment.");
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
  environment: Environment,
): ModelPolicy | undefined {
  const matchingPolicies = policies.filter(
    (policy) =>
      policy.stage === stage &&
      policy.role === role &&
      (model === null || policy.model === model) &&
      policy.compatibleEnvironments.includes(environment),
  );
  return matchingPolicies.reduce<ModelPolicy | undefined>(
    (selectedPolicy, policy) => selectedPolicy === undefined || policy.model < selectedPolicy.model ? policy : selectedPolicy,
    undefined,
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
  assertStage(stage);
  assertRole(role);
  assertEnvironment(environment);
  assertUniquePolicies(policies);
  assertOverrides(overrides);
  const routedRole = selectedRole(role, overrides);
  const routedEnvironment = selectedEnvironment(environment, overrides);
  const policy = findPolicy(stage, routedRole, overrides.model, policies, routedEnvironment);

  if (policy === undefined) {
    const requestedPolicy = policies
      .filter(
        (candidate) =>
          candidate.stage === stage &&
          candidate.role === routedRole &&
          (overrides.model === null || candidate.model === overrides.model),
      )
      .reduce<ModelPolicy | undefined>(
        (selectedPolicy, candidate) =>
          selectedPolicy === undefined || candidate.model < selectedPolicy.model ? candidate : selectedPolicy,
        undefined,
      );
    if (requestedPolicy !== undefined && (overrides.model !== null || overrides.environment !== null)) {
      throw new CapabilityMismatchError(
        `Model policy for stage=${stage}, role=${routedRole}, model=${requestedPolicy.model} is incompatible with environment=${routedEnvironment}.`,
      );
    }
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
