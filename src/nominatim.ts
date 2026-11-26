/**
 * Minimal Nominatim client that follows https://operations.osmfoundation.org/policies/nominatim/ :
 * identifying User-Agent, at most one request per second (serialized), and cached results.
 */
export const ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright). Geocoding by Nominatim.";

export interface Bbox {
  min_lon: number;
  min_lat: number;
  max_lon: number;
  max_lat: number;
}

export interface Place {
  display_name: string;
  lat: number;
  lon: number;
  osm_type?: "node" | "way" | "relation";
  osm_id?: number;
  category?: string;
  type?: string;
  importance?: number;
  /** Ready to pass to osm_get_bbox / osm_get_notes_in_bbox (check the area limit first). */
  bbox?: Bbox;
  address?: Record<string, string>;
}

export interface SearchArgs {
  query: string;
  limit?: number;
  country_codes?: string[];
  /** Restrict/bias results to this box. */
  viewbox?: Bbox;
  /** With viewbox: only return results inside it. */
  bounded?: boolean;
  language?: string;
}

export interface ReverseArgs {
  lat: number;
  lon: number;
  /** 3 country ... 10 suburb ... 18 building (default 18). */
  zoom?: number;
  language?: string;
}

export interface NominatimOptions {
  minIntervalMs?: number;
  ttlMs?: number;
  maxCache?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Nominatim bounding boxes are [south, north, west, east] strings. */
export function toBbox(b: unknown): Bbox | undefined {
  if (!Array.isArray(b) || b.length !== 4) return undefined;
  const [s, n, w, e] = b.map(Number);
  return [s, n, w, e].every(Number.isFinite) ? { min_lon: w, min_lat: s, max_lon: e, max_lat: n } : undefined;
}

export function toPlace(r: any): Place {
  return {
    display_name: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
    osm_type: r.osm_type,
    osm_id: r.osm_id !== undefined ? Number(r.osm_id) : undefined,
    category: r.category ?? r.class,
    type: r.type,
    importance: r.importance,
    bbox: toBbox(r.boundingbox),
    address: r.address,
  };
}

export class Nominatim {
  private chain: Promise<unknown> = Promise.resolve();
  private last = 0;
  private cache = new Map<string, { at: number; value: unknown }>();
  private minInterval: number;
  private ttl: number;
  private maxCache: number;

  constructor(private base: string, private userAgent: string, opts: NominatimOptions = {}) {
    this.minInterval = opts.minIntervalMs ?? 1100;
    this.ttl = opts.ttlMs ?? 10 * 60_000;
    this.maxCache = opts.maxCache ?? 200;
  }

  async search(a: SearchArgs): Promise<Place[]> {
    const q: Record<string, string> = {
      q: a.query,
      format: "jsonv2",
      addressdetails: "1",
      limit: String(Math.min(Math.max(a.limit ?? 5, 1), 10)),
    };
    if (a.country_codes?.length) q.countrycodes = a.country_codes.map((c) => c.toLowerCase()).join(",");
    if (a.viewbox) {
      // Nominatim wants left,top,right,bottom
      q.viewbox = `${a.viewbox.min_lon},${a.viewbox.max_lat},${a.viewbox.max_lon},${a.viewbox.min_lat}`;
      if (a.bounded) q.bounded = "1";
    }
    if (a.language) q["accept-language"] = a.language;
    const rows = (await this.get("/search", q)) as unknown[];
    return rows.map(toPlace);
  }

  async reverse(a: ReverseArgs): Promise<Place | null> {
    const q: Record<string, string> = { lat: String(a.lat), lon: String(a.lon), format: "jsonv2", addressdetails: "1", zoom: String(a.zoom ?? 18) };
    if (a.language) q["accept-language"] = a.language;
    const r = (await this.get("/reverse", q)) as any;
    return r?.error ? null : toPlace(r);
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const key = url.toString();
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.value;

    const run = this.chain.then(async () => {
      const wait = this.last + this.minInterval - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      const r = await fetch(url, { headers: { "user-agent": this.userAgent, accept: "application/json" } });
      const text = await r.text();
      if (!r.ok) {
        const hint = r.status === 429 || r.status === 403 ? " (rate limited or blocked; see the Nominatim usage policy and slow down)" : "";
        throw new Error(`Nominatim ${path} -> HTTP ${r.status}${hint}: ${text.trim().slice(0, 200)}`);
      }
      return JSON.parse(text) as unknown;
    });
    this.chain = run.catch(() => undefined);
    const value = await run;
    if (this.cache.size >= this.maxCache) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }
}
