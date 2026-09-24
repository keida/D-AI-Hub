import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultProjectOwnedAuditRoot, parseWindowsAuditAclOutput } from "../../src/project-owned/project-owned-reconciliation.js";

const path = "C:\\Users\\User\\.dai-project-owned-audits";
const currentName = "keida\\user";
const currentSid = "S-1-5-21-100-200-300-1001";
const trustedAcl = [
  `${path} KEIDA\\User:(OI)(CI)(F)`,
  "              NT AUTHORITY\\SYSTEM:(OI)(CI)(F)",
  "              BUILTIN\\Administrators:(OI)(CI)(F)",
  "Successfully processed 1 files; Failed processing 0 files",
].join("\r\n");

describe("Windows project-owned audit ACL validation", () => {
  it("accepts the exact path with current-user, SYSTEM, and Administrators grants", () => {
    expect(() => parseWindowsAuditAclOutput(trustedAcl, path, currentName, currentSid)).not.toThrow();
  });

  it("allows read-only principals on ancestors but rejects delete-child and write grants", () => {
    const ancestorAcl = `${path} BUILTIN\\Users:(RX)\r\nKEIDA\\User:(OI)(CI)(F)`;
    expect(() => parseWindowsAuditAclOutput(ancestorAcl, path, currentName, currentSid, "ancestor")).not.toThrow();
    for (const right of ["DC", "M", "D", "WDAC", "WO", "AD"]) {
      expect(() => parseWindowsAuditAclOutput(`${path} BUILTIN\\Users:(${right})\r\nKEIDA\\User:(OI)(CI)(F)`, path, currentName, currentSid, "parent")).toThrow();
    }
    expect(() => parseWindowsAuditAclOutput(`${path} S-1-15-3-123:(S,X)\r\nKEIDA\\User:(OI)(CI)(F)`, path, currentName, currentSid, "ancestor")).not.toThrow();
  });

  it.each([
    ["empty output", ""],
    ["wrong path", trustedAcl.replace(path, "C:\\Users\\Other\\audit")],
    ["path prefix without a boundary", trustedAcl.replace(`${path} `, `${path}-elsewhere `)],
    ["malformed ACL entry", `${path} not-an-ace\r\nSuccessfully processed 1 files; Failed processing 0 files`],
    ["unknown rights token", `${path} KEIDA\\User:(OI)(CI)(ZZ)`],
    ["no allow ACE", `${path}\r\nSuccessfully processed 1 files; Failed processing 0 files`],
    ["untrusted read ACE", `${path} BUILTIN\\Users:(OI)(CI)(RX)\r\nKEIDA\\User:(OI)(CI)(F)`],
    ["untrusted write ACE", `${path} BUILTIN\\Users:(OI)(CI)(M)\r\nKEIDA\\User:(OI)(CI)(F)`],
  ])("fails closed on %s", (_name, output) => {
    expect(() => parseWindowsAuditAclOutput(output, path, currentName, currentSid)).toThrow();
  });

  it("uses the same stable per-user default across service restarts", () => {
    expect(defaultProjectOwnedAuditRoot()).toBe(join(homedir(), ".dai-project-owned-audits"));
    expect(defaultProjectOwnedAuditRoot()).toBe(defaultProjectOwnedAuditRoot());
  });
});
