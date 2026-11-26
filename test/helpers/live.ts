import { existsSync } from "node:fs";
import { loadConfig } from "../../src/config.js";

const SANDBOX_HOSTS = new Set(["master.apis.dev.openstreetmap.org", "localhost", "127.0.0.1"]);

/**
 * Hard safety net: live tests perform real writes, so they may only ever target the OSM sandbox
 * (or a local server). Throws for anything else, including production and unparsable URLs.
 */
export function assertSandbox(apiBase: string): void {
  let host: string;
  try {
    host = new URL(apiBase).hostname;
  } catch {
    throw new Error(`Refusing live tests: cannot parse API base "${apiBase}".`);
  }
  if (!SANDBOX_HOSTS.has(host)) throw new Error(`Refusing live tests against "${host}": only the OSM sandbox (master.apis.dev.openstreetmap.org) or localhost is allowed.`);
}

/** Environment for a live-test server: always the dev sandbox, never production. */
export function liveEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base, OSM_ENV: "dev", OSM_ENABLE_GEOCODING: "" };
  assertSandbox(loadConfig(env).apiBase);
  return env;
}

/** True when a sandbox token is available (env var or the token file written by osm_login with OSM_ENV=dev). */
export function hasSandboxToken(base: NodeJS.ProcessEnv = process.env): boolean {
  const env = liveEnv(base);
  return Boolean(env.OSM_ACCESS_TOKEN) || existsSync(loadConfig(env).tokenFile);
}
