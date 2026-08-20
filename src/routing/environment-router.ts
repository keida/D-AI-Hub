import { CapabilityMismatchError, CloseBlockedError, InvalidTaskStateError } from "../domain/errors.js";
import type { Environment, Stage } from "../domain/types.js";
import type { EnvironmentCapabilities } from "./environment-capabilities.js";

export interface EnvironmentRouteInput {
  readonly stage: Stage;
  readonly requiredCapabilities: readonly string[];
  readonly available: readonly EnvironmentCapabilities[];
  readonly userEnvironmentOverride: Environment | null;
}

export interface EnvironmentRoute {
  readonly environment: Environment;
  readonly reason: string;
  readonly requiredCapabilities: readonly string[];
}

const defaultEnvironmentsByStage: ReadonlyMap<Stage, readonly Environment[]> = new Map([
  ["bootstrap", ["chat"]],
  ["route", ["chat"]],
  ["plan", ["chat", "work"]],
  ["execute", ["work", "codex"]],
  ["inspect", ["work", "codex"]],
  ["verify", ["work", "codex"]],
  ["debug", ["codex", "work"]],
  ["recover", ["codex", "work"]],
  ["handoff", ["chat", "work", "codex"]],
  ["close", ["work"]],
]);

const knownEnvironments: ReadonlySet<Environment> = new Set(["chat", "work", "codex"]);

function isEnvironment(value: unknown): value is Environment {
  return typeof value === "string" && knownEnvironments.has(value as Environment);
}

function isReadonlySetCompatible(value: unknown): value is ReadonlySet<string> {
  return value instanceof Set && Array.from(value).every((capability) => typeof capability === "string");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function assertAvailableEnvironments(available: unknown): asserts available is readonly EnvironmentCapabilities[] {
  if (!Array.isArray(available)) {
    throw new CapabilityMismatchError("Available environments must be an array of environment capability declarations");
  }

  const declaredEnvironments = new Set<Environment>();

  for (const candidate of available) {
    if (!isRecord(candidate)) {
      throw new CapabilityMismatchError("Available environments must contain environment capability declarations");
    }

    const environment = candidate.environment;
    if (!isEnvironment(environment)) {
      throw new CapabilityMismatchError(`Unknown environment declaration: ${String(environment)}`);
    }
    if (!isReadonlySetCompatible(candidate.capabilities)) {
      throw new CapabilityMismatchError(
        `Environment ${environment} must declare capabilities as a ReadonlySet-compatible collection`,
      );
    }
    if (declaredEnvironments.has(environment)) {
      throw new CapabilityMismatchError(`Duplicate environment declaration: ${environment}`);
    }
    declaredEnvironments.add(environment);
  }
}

function hasRequiredCapabilities(
  environment: EnvironmentCapabilities,
  requiredCapabilities: readonly string[],
): boolean {
  return requiredCapabilities.every((capability) => environment.capabilities.has(capability));
}

function findEnvironment(
  available: readonly EnvironmentCapabilities[],
  environment: Environment,
): EnvironmentCapabilities | undefined {
  return available.find((candidate) => candidate.environment === environment);
}

function getDefaultEnvironments(stage: Stage): readonly Environment[] {
  const environments = defaultEnvironmentsByStage.get(stage);
  if (environments === undefined) {
    throw new InvalidTaskStateError(`Unsupported routing stage: ${stage}`);
  }
  return environments;
}

function assertCloseContract(
  selectedEnvironment: EnvironmentCapabilities,
  available: readonly EnvironmentCapabilities[],
): void {
  if (!selectedEnvironment.capabilities.has("durable-context")) {
    throw new CloseBlockedError("Close requires Work to provide durable-context capability");
  }
  const codex = findEnvironment(available, "codex");
  if (codex === undefined || !codex.capabilities.has("codex-evidence")) {
    throw new CloseBlockedError("Close requires Codex to provide codex-evidence capability");
  }
}

function createRoute(
  stage: Stage,
  environment: Environment,
  requiredCapabilities: readonly string[],
  reason: string,
): EnvironmentRoute {
  return { environment, reason, requiredCapabilities: [...requiredCapabilities] };
}

export function selectEnvironment(input: EnvironmentRouteInput): EnvironmentRoute {
  assertAvailableEnvironments(input.available);
  const defaultEnvironments = getDefaultEnvironments(input.stage);

  if (input.userEnvironmentOverride !== null) {
    const override = findEnvironment(input.available, input.userEnvironmentOverride);
    if (
      override === undefined ||
      !defaultEnvironments.includes(input.userEnvironmentOverride) ||
      !hasRequiredCapabilities(override, input.requiredCapabilities)
    ) {
      throw new CapabilityMismatchError(
        `Environment override ${input.userEnvironmentOverride} cannot satisfy ${input.stage} with required capabilities: ${input.requiredCapabilities.join(", ")}`,
      );
    }
    if (input.stage === "close") {
      assertCloseContract(override, input.available);
      return createRoute(
        input.stage,
        override.environment,
        input.requiredCapabilities,
        `User override selected ${override.environment} for close after validating durable context and Codex evidence.`,
      );
    }
    return createRoute(
      input.stage,
      override.environment,
      input.requiredCapabilities,
      `User override selected ${override.environment} for ${input.stage}.`,
    );
  }

  const selectedEnvironment = defaultEnvironments
    .map((environment) => findEnvironment(input.available, environment))
    .find(
      (environment): environment is EnvironmentCapabilities =>
        environment !== undefined && hasRequiredCapabilities(environment, input.requiredCapabilities),
    );
  if (selectedEnvironment === undefined) {
    throw new CapabilityMismatchError(
      `No available environment can satisfy ${input.stage} with required capabilities: ${input.requiredCapabilities.join(", ")}`,
    );
  }
  if (input.stage === "close") {
    assertCloseContract(selectedEnvironment, input.available);
    return createRoute(
      input.stage,
      selectedEnvironment.environment,
      input.requiredCapabilities,
      "Default close routing selected work after validating durable context and Codex evidence.",
    );
  }
  return createRoute(
    input.stage,
    selectedEnvironment.environment,
    input.requiredCapabilities,
    `Default ${input.stage} routing selected ${selectedEnvironment.environment}.`,
  );
}
