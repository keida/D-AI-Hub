import { InvalidTaskStateError } from "../domain/errors.js";

export type DebugPhase =
  | "reproduce" | "capture" | "isolate" | "hypothesize"
  | "change" | "reverify" | "regress" | "stop";

export interface DebugSession {
  readonly phase: DebugPhase;
  readonly originalFailure: string;
  readonly hypothesis: string | null;
  readonly preservedRecoveryPointId: string;
}

export interface DebugTransition {
  readonly session: DebugSession;
  readonly reason: string;
}

const nextPhases: ReadonlyMap<DebugPhase, DebugPhase> = new Map([
  ["reproduce", "capture"],
  ["capture", "isolate"],
  ["isolate", "hypothesize"],
  ["hypothesize", "change"],
  ["change", "reverify"],
  ["reverify", "regress"],
  ["regress", "stop"],
]);

function assertText(value: string, label: string): void {
  if (value.trim().length === 0) throw new InvalidTaskStateError(`${label} must be non-empty`);
}

function assertRecoveryPrerequisites(session: DebugSession): void {
  assertText(session.originalFailure, "Original failure");
  assertText(session.preservedRecoveryPointId, "Preserved recovery point id");
}

export function createDebugSession(originalFailure: string, preservedRecoveryPointId: string): DebugSession {
  assertText(originalFailure, "Original failure");
  assertText(preservedRecoveryPointId, "Preserved recovery point id");
  return { phase: "reproduce", originalFailure, hypothesis: null, preservedRecoveryPointId };
}

export function setDebugHypothesis(session: DebugSession, hypothesis: string): DebugSession {
  if (session.phase !== "hypothesize") throw new InvalidTaskStateError(`A hypothesis can only be set during hypothesize, not ${session.phase}`);
  assertText(hypothesis, "Debug hypothesis");
  return { ...session, hypothesis };
}

export function advanceDebugSession(session: DebugSession): DebugSession {
  const nextPhase = nextPhases.get(session.phase);
  if (nextPhase === undefined) throw new InvalidTaskStateError(`Debugging session cannot advance from ${session.phase}`);
  if (session.phase === "hypothesize") {
    assertRecoveryPrerequisites(session);
    if (session.hypothesis === null || session.hypothesis.trim().length === 0) throw new InvalidTaskStateError("A non-empty hypothesis is required before change");
  }
  return { ...session, phase: nextPhase };
}

function assertFailurePhase(session: DebugSession): void {
  if (session.phase !== "reverify" && session.phase !== "regress") throw new InvalidTaskStateError(`Repeated failure can only be recorded during reverify or regress, not ${session.phase}`);
}

export function recordRepeatedFailure(session: DebugSession, reason: string): DebugTransition {
  assertFailurePhase(session);
  assertText(reason, "Repeated failure reason");
  return { session: { ...session, phase: "hypothesize", hypothesis: null }, reason };
}

export function stopAfterRepeatedFailure(session: DebugSession, reason: string): DebugTransition {
  assertFailurePhase(session);
  assertText(reason, "Repeated failure reason");
  return { session: { ...session, phase: "stop" }, reason };
}
