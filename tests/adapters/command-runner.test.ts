import { describe, expect, it } from "vitest";
import { redactSensitiveText, runCommand } from "../../src/adapters/command-runner.js";

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

  it("redacts values that follow separate sensitive arguments", async () => {
    const result = await runCommand({
      command: process.execPath,
      arguments: ["-e", "process.exit(0)", "--", "--password", "hunter2", "--token", "token-value"],
      cwd: null,
    });

    expect(result.arguments).toEqual(["-e", "process.exit(0)", "--", "--password", "[REDACTED]", "--token", "[REDACTED]"]);
  });

  it("redacts credentials embedded in URL userinfo from arguments and output", async () => {
    const credentialUrl = "https://user:fixture-secret@example.com/repo";
    const result = await runCommand({
      command: process.execPath,
      arguments: ["-e", `process.stdout.write(${JSON.stringify(credentialUrl)})`, "--", credentialUrl],
      cwd: null,
    });

    expect(result.arguments.at(-1)).toBe("https://[REDACTED]@example.com/repo");
    expect(result.stdout).toBe("https://[REDACTED]@example.com/repo");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
  });
});
