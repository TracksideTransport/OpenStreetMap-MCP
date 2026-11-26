import type { ElementType } from "./osm.js";

export interface Box {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

export interface MapElement {
  type: ElementType;
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: unknown[];
  [meta: string]: unknown;
}

export interface BboxQuery {
  types?: ElementType[];
  /** Keep elements having ANY of these tags: "key" (any value) or "key=value". */
  tagFilters?: string[];
  taggedOnly?: boolean;
  /** Drop nodes outside this box (the API returns every node of every way that touches it). */
  insideOnly?: Box;
  /** Keep only type, id, lat, lon, tags, nodes, members (drops version, timestamp, changeset, uid, user). */
  compact?: boolean;
  offset: number;
  limit: number;
  /** Stop adding elements to a page after roughly this many JSON characters. */
  budgetChars?: number;
}

export interface BboxPage {
  total_matching: number;
  offset: number;
  returned: number;
  /** Pass as `offset` to get the next page; null when this was the last. */
  next_offset: number | null;
  elements: MapElement[];
}

export const DEFAULT_BUDGET = 45_000;

export function parseTagFilter(f: string): { key: string; value?: string } {
  const i = f.indexOf("=");
  if (i < 0) return { key: f.trim() };
  const value = f.slice(i + 1).trim();
  return { key: f.slice(0, i).trim(), value: value === "" || value === "*" ? undefined : value };
}

function insideBox(e: MapElement, b: Box): boolean {
  return typeof e.lat === "number" && typeof e.lon === "number" && e.lat >= b.min_lat && e.lat <= b.max_lat && e.lon >= b.min_lon && e.lon <= b.max_lon;
}

const hasTags = (e: MapElement) => !!e.tags && Object.keys(e.tags).length > 0;

export function compactElement(e: MapElement): MapElement {
  const o: MapElement = { type: e.type, id: e.id };
  if (e.lat !== undefined) o.lat = e.lat;
  if (e.lon !== undefined) o.lon = e.lon;
  if (e.tags) o.tags = e.tags;
  if (e.nodes) o.nodes = e.nodes;
  if (e.members) o.members = e.members;
  return o;
}

/** Filter, then return one page that is complete (no element is cut) and fits the size budget. */
export function filterAndPage(all: MapElement[], q: BboxQuery): BboxPage {
  const wanted = q.types && q.types.length ? new Set<string>(q.types) : undefined;
  const filters = (q.tagFilters ?? []).map(parseTagFilter).filter((f) => f.key);
  const matches = all.filter((e) => {
    if (wanted && !wanted.has(e.type)) return false;
    if (q.insideOnly && e.type === "node" && !insideBox(e, q.insideOnly)) return false;
    if (q.taggedOnly && !hasTags(e)) return false;
    if (filters.length && !filters.some((f) => e.tags && f.key in e.tags && (f.value === undefined || e.tags[f.key] === f.value))) return false;
    return true;
  });

  const budget = q.budgetChars ?? DEFAULT_BUDGET;
  const page: MapElement[] = [];
  let used = 0;
  for (let i = q.offset; i < matches.length && page.length < q.limit; i++) {
    const el = q.compact ? compactElement(matches[i]) : matches[i];
    const size = JSON.stringify(el).length + 1;
    if (page.length > 0 && used + size > budget) break; // always return at least one element, even a huge one
    page.push(el);
    used += size;
  }
  const end = q.offset + page.length;
  return { total_matching: matches.length, offset: q.offset, returned: page.length, next_offset: end < matches.length ? end : null, elements: page };
}
