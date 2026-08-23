import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/adapters/command-runner.js";

describe("redactSensitiveText", () => {
  it.each([
    ["password=\"quoted-secret\"", "password=[REDACTED]"],
    ["password=plain-secret", "password=[REDACTED]"],
    ["token='quoted-secret'", "token=[REDACTED]"],
    ["credential=\"quoted-secret\"", "credential=[REDACTED]"],
    ["access-token=\"quoted-secret\"", "access-token=[REDACTED]"],
    ["private_key='quoted-secret'", "private_key=[REDACTED]"],
    ["cookie=\"quoted-secret\"", "cookie=[REDACTED]"],
    ["session-token='quoted-secret'", "session-token=[REDACTED]"],
    ["auth=plain-secret", "auth=[REDACTED]"],
    ['Authorization: Bearer "quoted-token"', "Authorization: Bearer [REDACTED]"],
    ["Authorization: Bearer plain-token", "Authorization: Bearer [REDACTED]"],
    ["authorization: bearer 'quoted-token'", "authorization: bearer [REDACTED]"],
  ])("redacts quoted credentials: %s", (value, expected) => {
    expect(redactSensitiveText(value)).toBe(expected);
  });
});
