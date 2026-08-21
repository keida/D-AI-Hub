import { redactSensitiveText } from "../adapters/command-runner.js";
import type { HealthFinding } from "./types.js";

export function redactHealthFinding(finding: HealthFinding): HealthFinding {
  return {
    ...finding,
    relativePath: redactSensitiveText(finding.relativePath),
    message: redactSensitiveText(finding.message),
  };
}

export function redactHealthFindings(findings: readonly HealthFinding[]): readonly HealthFinding[] {
  return findings.map(redactHealthFinding);
}
