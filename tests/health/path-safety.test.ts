import { posix, win32 } from "node:path";
import { describe, expect, test } from "vitest";
import { isPathWithinRoot } from "../../src/health/path-safety.js";

describe("repository path containment", () => {
  test("rejects POSIX parent traversal using POSIX path semantics", () => {
    expect(posix.relative("/repository", "/outside/file.md")).toBe("../outside/file.md");
    expect(isPathWithinRoot("/repository", "/outside/file.md", posix)).toBe(false);
    expect(isPathWithinRoot("/repository", "/repository/docs/file.md", posix)).toBe(true);
  });

  test("preserves Windows parent traversal semantics", () => {
    expect(win32.relative("C:\\repository", "C:\\outside\\file.md")).toBe("..\\outside\\file.md");
    expect(isPathWithinRoot("C:\\repository", "C:\\outside\\file.md", win32)).toBe(false);
    expect(isPathWithinRoot("C:\\repository", "C:\\repository\\docs\\file.md", win32)).toBe(true);
  });
});
