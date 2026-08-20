import { describe, expect, it } from "vitest";
import { InvalidTaskStateError } from "../../src/domain/errors.js";
import { parseDAICommand } from "../../src/entry/command-parser.js";

describe("parseDAICommand", () => {
  it.each([
    ["@D-AI implement the runtime", { kind: "intent", text: "implement the runtime" }],
    ["  @D-AI   implement   the runtime  ", { kind: "intent", text: "implement the runtime" }],
    ["@D-AI continue task-123", { kind: "continue", taskIdOrProject: "task-123" }],
    ["@D-AI status", { kind: "status" }],
    ["@D-AI handoff chat", { kind: "handoff", target: "chat" }],
    ["@D-AI handoff work", { kind: "handoff", target: "work" }],
    ["@D-AI handoff codex", { kind: "handoff", target: "codex" }],
    ["@D-AI complete handoff-task-1", { kind: "complete", handoffId: "handoff-task-1" }],
    ["@D-AI close", { kind: "close" }],
  ] as const)("normalizes %s", (input, expected) => {
    expect(parseDAICommand(input)).toEqual(expected);
  });

  it.each([
    "",
    "@D-AI",
    "continue task-123",
    "status",
    "@D-AI continue",
    "@D-AI continue task-123 extra",
    "@D-AI status now",
    "@D-AI handoff",
    "@D-AI handoff slack",
    "@D-AI handoff work extra",
    "@D-AI complete",
    "@D-AI complete handoff-task-1 extra",
    "@D-AI close now",
  ])("rejects malformed or non-prefixed input: %s", (input) => {
    expect(() => parseDAICommand(input)).toThrow(InvalidTaskStateError);
  });
});
