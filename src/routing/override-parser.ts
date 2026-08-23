import { InvalidTaskStateError } from "../domain/errors.js";
import type { Environment, Role, Stage } from "../domain/types.js";

export interface RoutingOverrides {
  readonly model: string | null;
  readonly role: Role | null;
  readonly environment: Environment | null;
  readonly stage?: Stage | null;
}

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

function parseToken(token: string): readonly [string, string] {
  const separatorIndex = token.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex !== token.lastIndexOf("=")) {
    throw new InvalidTaskStateError(`Malformed routing override: ${token}`);
  }

  const key = token.slice(0, separatorIndex);
  const value = token.slice(separatorIndex + 1);
  if (value.trim().length === 0) {
    throw new InvalidTaskStateError(`Routing override ${key} must not have an empty value`);
  }
  return [key, value];
}

function parseRole(value: string): Role {
  if (!roles.has(value)) {
    throw new InvalidTaskStateError(`Invalid role override: ${value}`);
  }
  return value as Role;
}

function parseEnvironment(value: string): Environment {
  if (!environments.has(value)) {
    throw new InvalidTaskStateError(`Invalid environment override: ${value}`);
  }
  return value as Environment;
}

function parseStage(value: string): Stage {
  if (!stages.has(value)) {
    throw new InvalidTaskStateError(`Invalid stage override: ${value}`);
  }
  return value as Stage;
}

export function parseRoutingOverrides(tokens: readonly string[]): RoutingOverrides {
  if (!Array.isArray(tokens)) {
    throw new InvalidTaskStateError("Routing override tokens must be an array.");
  }

  let model: string | null = null;
  let role: Role | null = null;
  let environment: Environment | null = null;
  let stage: Stage | null = null;
  const keys = new Set<string>();

  for (const [index, token] of tokens.entries()) {
    if (typeof token !== "string") {
      throw new InvalidTaskStateError(`Routing override at index=${index} must be a string.`);
    }
    const [key, value] = parseToken(token);
    if (keys.has(key)) {
      throw new InvalidTaskStateError(`Duplicate routing override key: ${key}`);
    }
    keys.add(key);

    if (key === "model") {
      model = value;
      continue;
    }
    if (key === "role") {
      role = parseRole(value);
      continue;
    }
    if (key === "environment") {
      environment = parseEnvironment(value);
      continue;
    }
    if (key === "stage") {
      stage = parseStage(value);
      continue;
    }
    throw new InvalidTaskStateError(`Unsupported routing override key: ${key}`);
  }

  return { model, role, environment, stage };
}
