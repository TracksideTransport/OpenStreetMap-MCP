import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";

export type ElementType = "node" | "way" | "relation";

export interface Member {
  type: ElementType;
  ref: number;
  role?: string;
}

export interface ElementInput {
  type: ElementType;
  /** Required for modify/delete. For create inside a diff, a negative placeholder id. */
  id?: number;
  /** Required for modify/delete (current version, for optimistic locking). */
  version?: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: Member[];
  tags?: Record<string, string>;
}

export class OsmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "OsmError";
  }
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: false, suppressEmptyNode: true });

export const parseXml = (s: string) => xmlParser.parse(s);

const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Convert an element to the fast-xml-parser object shape for <node|way|relation>. */
export function elementToXmlObject(e: ElementInput, changeset?: number) {
  const o: Record<string, unknown> = {};
  if (e.id !== undefined) o["@_id"] = e.id;
  if (e.version !== undefined) o["@_version"] = e.version;
  if (changeset !== undefined) o["@_changeset"] = changeset;
  if (e.type === "node") {
    if (e.lat === undefined || e.lon === undefined) {
      // delete requests may still need lat/lon per API; caller supplies them.
    } else {
      o["@_lat"] = e.lat;
      o["@_lon"] = e.lon;
    }
  }
  if (e.type === "way") o.nd = (e.nodes ?? []).map((ref) => ({ "@_ref": ref }));
  if (e.type === "relation")
    o.member = (e.members ?? []).map((m) => ({ "@_type": m.type, "@_ref": m.ref, "@_role": m.role ?? "" }));
  o.tag = Object.entries(e.tags ?? {}).map(([k, v]) => ({ "@_k": k, "@_v": v }));
  return o;
}

export function buildElementXml(e: ElementInput, changeset: number): string {
  return xmlBuilder.build({ osm: { [e.type]: elementToXmlObject(e, changeset) } });
}

export function buildChangesetXml(tags: Record<string, string>): string {
  return xmlBuilder.build({
    osm: { changeset: { tag: Object.entries(tags).map(([k, v]) => ({ "@_k": k, "@_v": v })) } },
  });
}

export interface DiffInput {
  create?: ElementInput[];
  modify?: ElementInput[];
  delete?: ElementInput[];
}

export function buildOsmChangeXml(diff: DiffInput, changeset: number): string {
  const section = (els: ElementInput[] | undefined) => {
    const grouped: Record<string, unknown[]> = {};
    for (const e of els ?? []) (grouped[e.type] ??= []).push(elementToXmlObject(e, changeset));
    return grouped;
  };
  const root: Record<string, unknown> = { "@_version": "0.6", "@_generator": "openstreetmap-mcp" };
  if (diff.create?.length) root.create = section(diff.create);
  if (diff.modify?.length) root.modify = section(diff.modify);
  if (diff.delete?.length) root.delete = section(diff.delete);
  return xmlBuilder.build({ osmChange: root });
}

export function parseDiffResult(xml: string) {
  const parsed = parseXml(xml);
  const out: { type: string; old_id: number; new_id?: number; new_version?: number }[] = [];
  for (const type of ["node", "way", "relation"] as const) {
    for (const r of arr(parsed?.diffResult?.[type])) {
      out.push({
        type,
        old_id: Number(r["@_old_id"]),
        new_id: r["@_new_id"] !== undefined ? Number(r["@_new_id"]) : undefined,
        new_version: r["@_new_version"] !== undefined ? Number(r["@_new_version"]) : undefined,
      });
    }
  }
  return out;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: string;
  contentType?: string;
  /** "required" attaches the token and fails if absent; "optional" attaches it when present. */
  auth?: "required" | "optional" | "none";
}

export class OsmClient {
  constructor(private cfg: Config, private auth: Auth) {}

  private async raw(method: string, path: string, opts: RequestOptions = {}): Promise<{ status: number; text: string }> {
    const url = new URL(`${this.cfg.apiBase}/api/0.6${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    // Writes must ask for XML: e.g. /changeset/N/upload answers with an empty JSON object otherwise, losing the diffResult.
    const accept = method === "GET" ? "application/json, application/xml;q=0.9, */*;q=0.5" : "application/xml, text/plain;q=0.9, */*;q=0.5";
    const headers: Record<string, string> = { "user-agent": this.cfg.userAgent, accept };
    const mode = opts.auth ?? "none";
    if (mode === "required") headers.authorization = `Bearer ${await this.auth.requireToken()}`;
    else if (mode === "optional") {
      const t = await this.auth.getToken();
      if (t) headers.authorization = `Bearer ${t}`;
    }
    if (opts.body !== undefined) headers["content-type"] = opts.contentType ?? "text/xml";
    const r = await fetch(url, { method, headers, body: opts.body });
    const text = await r.text();
    if (!r.ok) {
      const hint =
        r.status === 401 ? " (authentication failed; re-run osm_login or check scopes)" :
        r.status === 403 ? " (forbidden; token may lack the required scope, or the changeset belongs to another user)" :
        r.status === 409 ? " (conflict; stale element version, changeset closed/not yet closed, or changeset full)" :
        r.status === 410 ? " (element has been deleted)" :
        r.status === 412 ? " (precondition failed; referenced elements are missing or still in use)" :
        r.status === 429 ? " (rate limited)" : "";
      throw new OsmError(r.status, `OSM API ${method} ${path} -> HTTP ${r.status}${hint}: ${text.trim().slice(0, 500)}`);
    }
    return { status: r.status, text };
  }

  /** GET a `.json`-capable endpoint. */
  async getJson<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { text } = await this.raw("GET", path, opts);
    return JSON.parse(text) as T;
  }

  async getText(path: string, opts: RequestOptions = {}): Promise<string> {
    return (await this.raw("GET", path, opts)).text;
  }

  async send(method: "PUT" | "POST" | "DELETE", path: string, opts: RequestOptions = {}): Promise<string> {
    return (await this.raw(method, path, { auth: "required", ...opts })).text;
  }
}
