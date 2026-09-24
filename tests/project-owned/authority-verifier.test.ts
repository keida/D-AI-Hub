import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  HumanConfirmationVerifier,
  TerminalOperatorInteraction,
  type HumanConfirmationBinding,
} from "../../src/project-owned/authority-verifier.js";

const binding: HumanConfirmationBinding = {
  project: { identity: "github.com/keida/skill-pulse", workId: "SP-OPS-006", executionOwnerId: "worker-1" },
  dai: { taskId: "task-0123456789abcdef" },
  result: { resultId: "result-1", contract: "dai.project-result", schemaVersion: 1 },
  artifact: {
    repositoryIdentity: "github.com/keida/skill-pulse",
    canonicalPath: "docs/project-results/result.json",
    publicationCommitSha: "a".repeat(40),
    gitBlobOid: "b".repeat(40),
    sha256: "c".repeat(64),
  },
  evidenceRefs: [{
    id: "snapshot",
    kind: "git-blob",
    repositoryIdentity: "github.com/keida/skill-pulse",
    commitSha: "a".repeat(40),
    path: "snapshot.json",
    blobOid: "d".repeat(40),
    sha256: "e".repeat(64),
  }],
};

describe("HumanConfirmationVerifier", () => {
  it("records operator intent only after an exact challenge confirmation", async () => {
    let shownBinding: HumanConfirmationBinding | undefined;
    let challenge = "";
    const verifier = new HumanConfirmationVerifier(
      { confirm: async (shown, value) => { shownBinding = shown; challenge = value; return true; } },
      () => new Date("2026-09-25T00:00:00.000Z"),
      () => "01234567-89ab-4def-8123-456789abcdef",
    );

    const event = await verifier.capture(binding);

    expect(shownBinding).toEqual(binding);
    expect(challenge).toMatch(/^[A-F0-9]{12}$/u);
    expect(event).toMatchObject({
      authorityState: "HUMAN-CONFIRMED",
      intent: "RECONCILE_PROJECT_OWNED_RESULT",
      project: binding.project,
      dai: binding.dai,
      artifact: binding.artifact,
      evidenceRefs: binding.evidenceRefs,
      operatorContext: { host: "local" },
    });
  });

  it("rejects absent or incorrect operator input and non-interactive terminals", async () => {
    const declined = new HumanConfirmationVerifier({ confirm: async () => false });
    await expect(declined.capture(binding)).rejects.toThrow("did not confirm");

    const input = new PassThrough();
    const output = new PassThrough();
    const terminal = new HumanConfirmationVerifier(new TerminalOperatorInteraction(input, output));
    await expect(terminal.capture(binding)).rejects.toThrow("interactive local terminal");
  });
});
