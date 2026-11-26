import { createRequire } from "node:module";

export const SERVER_NAME = "openstreetmap-mcp";

/**
 * Read from package.json so the running server can never disagree with the published package.
 * Works from `src/` (tsx, tests) and `dist/` (published): package.json is one level up in both.
 */
export const VERSION: string = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
