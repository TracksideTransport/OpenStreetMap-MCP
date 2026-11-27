import type { ServerContext } from "@modelcontextprotocol/server";
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

export const MAX_CHARS = 60_000;

interface Truncation {
  field: string;
  kept: number;
  total: number;
}

/**
 * Serialize a result so it always fits MAX_CHARS *and stays valid JSON*. Slicing the text mid-element (the old
 * behavior) produced unparsable output for any big response. Instead: pretty-print if it fits, else compact, else
 * drop whole items from the largest array(s) and say so in a `truncated` field.
 */
export function fitJson(data: unknown, max: number = MAX_CHARS): string {
  const pretty = JSON.stringify(data, null, 2);
  if (pretty === undefined || pretty.length <= max) return pretty ?? "null";
  const compact = JSON.stringify(data);
  if (compact.length <= max) return compact;

  const isObj = data !== null && typeof data === "object" && !Array.isArray(data);
  const root: Record<string, unknown> = isObj ? { ...(data as Record<string, unknown>) } : { items: data };
  const notes: Truncation[] = [];
  const render = () => JSON.stringify({ ...root, ...(notes.length ? { truncated: { note: "Result was too large; items were dropped whole, so what remains is complete and valid. Narrow the query or page through it.", fields: notes } } : {}) });

  for (let round = 0; round < 6 && render().length > max; round++) {
    // trim the array that costs the most
    let key: string | undefined;
    let size = 0;
    for (const [k, v] of Object.entries(root)) {
      if (Array.isArray(v) && v.length > 0) {
        const n = JSON.stringify(v).length;
        if (n > size) [key, size] = [k, n];
      }
    }
    if (key === undefined) break;
    const arr = root[key] as unknown[];
    const total = (notes.find((n) => n.field === key)?.total ?? arr.length);
    let lo = 0;
    let hi = arr.length - 1; // must drop at least one item
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      root[key] = arr.slice(0, mid);
      notes.splice(0, notes.length, ...notes.filter((n) => n.field !== key), { field: key, kept: mid, total });
      if (render().length <= max) lo = mid;
      else hi = mid - 1;
    }
    root[key] = arr.slice(0, lo);
    notes.splice(0, notes.length, ...notes.filter((n) => n.field !== key), { field: key, kept: lo, total });
  }
  const out = render();
  // nothing left to trim (for example one enormous string): fall back to a clear error rather than broken JSON
  return out.length <= max ? out : JSON.stringify({ error: "Result too large to return", chars: compact.length, note: "Narrow the query." });
}

export function ok(data: unknown) {
  let text: string;
  if (typeof data === "string") {
    text = data.length > MAX_CHARS ? `${data.slice(0, MAX_CHARS)}\n... [truncated ${data.length - MAX_CHARS} chars; narrow the query]` : data;
  } else {
    text = fitJson(data);
  }
  return { content: [{ type: "text" as const, text }] };
}

export function fail(e: unknown) {
  const msg = e instanceof OsmError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: msg }], isError: true as const };
}

/** Wrap a handler so thrown errors become tool errors the model can read. */
export function safe<A>(fn: (args: A, ctx: ServerContext) => Promise<unknown>) {
  return async (args: A, ctx: ServerContext) => {
    try {
      return ok(await fn(args, ctx));
    } catch (e) {
      return fail(e);
    }
  };
}
