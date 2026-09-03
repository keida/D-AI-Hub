import { defineConfig } from "vitest/config";

export default defineConfig({
  root: process.cwd(),
  test: {
    include: ["diagnostics/linux-descendant-cleanup-diagnostic.ts"],
    testTimeout: 120_000,
    minWorkers: 1,
    maxWorkers: 1,
  },
});
