import type { AuthLike } from "../auth.js";
import type { Config } from "../config.js";
import type { OsmClient } from "../osm.js";
import { OsmError } from "../osm.js";

export interface Ctx {
  cfg: Config;
  auth: AuthLike;
  osm: OsmClient;
}

export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
export const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

const MAX_CHARS = 60_000;

export function ok(data: unknown) {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + `\n... [truncated ${text.length - MAX_CHARS} chars; narrow the query]`;
  }
  return { content: [{ type: "text" as const, text }] };
}

export function fail(e: unknown) {
  const msg = e instanceof OsmError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

/** Wrap a handler so thrown errors become tool errors the model can read. */
export function safe<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}
