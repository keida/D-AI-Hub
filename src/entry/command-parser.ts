import { InvalidTaskStateError } from "../domain/errors.js";
import type { Environment } from "../domain/types.js";

export type DAICommand =
  | { readonly kind: "intent"; readonly text: string }
  | { readonly kind: "continue"; readonly taskIdOrProject: string }
  | { readonly kind: "status" }
  | { readonly kind: "handoff"; readonly target: Environment }
  | { readonly kind: "complete"; readonly handoffId: string }
  | { readonly kind: "close" }
  | { readonly kind: "rollback" };

const commandPrefix = "@D-AI";
const environments: ReadonlySet<string> = new Set(["chat", "work", "codex"]);
const reservedCommands: ReadonlySet<string> = new Set(["continue", "status", "handoff", "complete", "close", "rollback"]);

function normalizedTokens(input: string): readonly string[] {
  if (typeof input !== "string") {
    throw new InvalidTaskStateError("D-AI command input must be a string");
  }
  const tokens = input.trim().split(/\s+/u);
  if (tokens.length < 2 || tokens[0] !== commandPrefix) {
    throw new InvalidTaskStateError("D-AI commands must begin with @D-AI and include a command or intent");
  }
  return tokens;
}

function parseEnvironment(value: string): Environment {
  if (!environments.has(value)) {
    throw new InvalidTaskStateError(`Unsupported handoff environment: ${value}`);
  }
  return value as Environment;
}

function assertArgumentCount(command: string, arguments_: readonly string[], count: number): void {
  if (arguments_.length !== count) {
    throw new InvalidTaskStateError(`${command} requires exactly ${count} argument${count === 1 ? "" : "s"}`);
  }
}

export function parseDAICommand(input: string): DAICommand {
  const tokens = normalizedTokens(input);
  const command = tokens[1];
  if (command === undefined) {
    throw new InvalidTaskStateError("D-AI command or intent is missing");
  }
  const arguments_ = tokens.slice(2);

  if (command === "continue") {
    if (arguments_.length === 0) {
      throw new InvalidTaskStateError("continue requires a task or project name");
    }
    return { kind: "continue", taskIdOrProject: arguments_.join(" ") };
  }
  if (command === "status") {
    assertArgumentCount(command, arguments_, 0);
    return { kind: "status" };
  }
  if (command === "handoff") {
    assertArgumentCount(command, arguments_, 1);
    return { kind: "handoff", target: parseEnvironment(arguments_[0]!) };
  }
  if (command === "complete") {
    assertArgumentCount(command, arguments_, 1);
    return { kind: "complete", handoffId: arguments_[0]! };
  }
  if (command === "close") {
    assertArgumentCount(command, arguments_, 0);
    return { kind: "close" };
  }
  if (command === "rollback") {
    assertArgumentCount(command, arguments_, 0);
    return { kind: "rollback" };
  }
  if (reservedCommands.has(command)) {
    throw new InvalidTaskStateError(`Malformed D-AI command: ${command}`);
  }
  return { kind: "intent", text: tokens.slice(1).join(" ") };
}
