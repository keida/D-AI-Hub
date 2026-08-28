import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    minWorkers: 2,
    maxWorkers: 2,
    testTimeout: 30_000,
  },
});
