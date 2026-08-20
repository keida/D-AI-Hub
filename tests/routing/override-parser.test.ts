import { describe, expect, it } from "vitest";
import { InvalidTaskStateError } from "../../src/domain/errors.js";
import { parseRoutingOverrides } from "../../src/routing/override-parser.js";

describe("parseRoutingOverrides", () => {
  it("parses the supported routing overrides without modifying tokens", () => {
    const tokens = ["model=gpt-5", "role=reviewer", "environment=codex"];

    expect(parseRoutingOverrides(tokens)).toEqual({
      model: "gpt-5",
      role: "reviewer",
      environment: "codex",
    });
    expect(tokens).toEqual(["model=gpt-5", "role=reviewer", "environment=codex"]);
  });

  it("returns null for each unspecified override", () => {
    expect(parseRoutingOverrides([])).toEqual({ model: null, role: null, environment: null });
  });

  it.each([
    ["provider=gpt-5", "Unsupported routing override key: provider"],
    ["model=gpt-5", "Duplicate routing override key: model", "model=gpt-5"],
    ["model=", "Routing override model must not have an empty value"],
    ["role=writer", "Invalid role override: writer"],
    ["environment=desktop", "Invalid environment override: desktop"],
    ["model=gpt-5=fast", "Malformed routing override: model=gpt-5=fast"],
    ["model", "Malformed routing override: model"],
  ])("rejects invalid override syntax: %s", (firstToken, expectedMessage, secondToken?: string) => {
    const tokens = secondToken === undefined ? [firstToken] : [firstToken, secondToken];

    expect(() => parseRoutingOverrides(tokens)).toThrow(InvalidTaskStateError);
    expect(() => parseRoutingOverrides(tokens)).toThrowError(expectedMessage);
  });
});
