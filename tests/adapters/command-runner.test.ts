import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/adapters/command-runner.js";

describe("redactSensitiveText", () => {
  it.each([["password=\"quoted-secret\"", "password=[REDACTED]"], ["token='quoted-secret'", "token=[REDACTED]"]])("redacts quoted assignments: %s", (value, expected) => {
    expect(redactSensitiveText(value)).toBe(expected);
  });
});
