import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalPath } from "../../src/domain/canonical-path.js";

describe("canonicalPath", () => {
  it("resolves a filesystem alias while retaining missing descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "d-ai-canonical-path-"));
    const target = join(root, "target");
    const alias = join(root, "alias");
    try {
      await mkdir(target);
      await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");

      await expect(canonicalPath(join(alias, "missing", "child"))).resolves.toBe(join(target, "missing", "child"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "win32")("fails closed when no ancestor can be resolved", async () => {
    const absentDrive = ["Z", "Y", "X", "W", "V", "U"].find((drive) => !existsSync(`${drive}:\\`));
    if (absentDrive === undefined) throw new Error("Test requires one unavailable Windows drive letter");

    await expect(canonicalPath(`${absentDrive}:\\missing\\workspace`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
