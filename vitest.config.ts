import { defineConfig } from "vitest/config";

// Default suite: fast, hermetic. Live sandbox tests are excluded; run them with `npm run test:live`.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], exclude: ["test/live/**", "node_modules/**"] },
});
