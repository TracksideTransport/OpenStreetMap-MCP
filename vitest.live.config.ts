import { defineConfig } from "vitest/config";

// Live tests hit the OSM sandbox with real writes: run files one at a time, with generous timeouts.
export default defineConfig({
  test: { include: ["test/live/**/*.live.test.ts"], testTimeout: 120_000, hookTimeout: 120_000, fileParallelism: false },
});
