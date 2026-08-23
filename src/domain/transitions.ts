import { InvalidTaskStateError } from "./errors.js";
import type { Stage } from "./types.js";

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

const allowedTransitions: ReadonlyMap<Stage, ReadonlySet<Stage>> = new Map([
  ["bootstrap", new Set(["route"])],
  ["route", new Set(["plan"])],
  ["plan", new Set(["execute", "handoff"])],
  ["execute", new Set(["inspect", "debug", "handoff"])],
  ["inspect", new Set(["verify", "debug", "handoff"])],
  ["verify", new Set(["close", "debug", "recover", "handoff"])],
  ["debug", new Set(["recover", "execute", "handoff"])],
  ["recover", new Set(["execute", "inspect", "verify", "handoff"])],
  ["handoff", new Set(["plan", "execute", "inspect", "verify", "debug", "recover"])],
  ["close", new Set()],
]);

function assertKnownStage(stage: string, label: string): asserts stage is Stage {
  if (!stages.has(stage)) {
    throw new InvalidTaskStateError(`Unknown ${label} stage: ${stage}`);
  }
}

export function assertStageTransition(from: Stage, to: Stage): void {
  assertKnownStage(from, "source");
  assertKnownStage(to, "target");

  const targets = allowedTransitions.get(from);
  if (targets === undefined || !targets.has(to)) {
    throw new InvalidTaskStateError(`Invalid stage transition: ${from} -> ${to}`);
  }
}
