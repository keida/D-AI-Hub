import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "d-ai-memory-git-transfer-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("preserves Git-tracked memory bundle bytes when Windows line-ending conversion is enabled", async () => {
  const root = await createRoot();
  const attributesPath = resolve(".gitattributes");
  const attributes = await readFile(attributesPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const recordsRelativePath = "memory-bundles/acceptance/records.jsonl";
  const recordsPath = join(root, recordsRelativePath);
  const expected = Buffer.from('{"memoryId":"note-1"}\n', "utf8");

  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "core.autocrlf", "true"], { cwd: root });
  await writeFile(join(root, ".gitattributes"), attributes, "utf8");
  await mkdir(dirname(recordsPath), { recursive: true });
  await writeFile(recordsPath, expected);
  await execFileAsync("git", ["add", "--", ".gitattributes", recordsRelativePath], { cwd: root });

  await writeFile(recordsPath, "force Git to materialize the indexed bytes", "utf8");
  await execFileAsync("git", ["checkout-index", "--force", "--", recordsRelativePath], { cwd: root });

  expect(await readFile(recordsPath)).toEqual(expected);
});
