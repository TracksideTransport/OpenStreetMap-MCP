import { XMLParser } from "fast-xml-parser";
import type { Bbox } from "./nominatim.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => ["trk", "trkseg", "trkpt", "wpt", "rtept", "rte"].includes(name),
});

export interface GpxPoint {
  lat: number;
  lon: number;
  ele?: number;
  time?: string;
}

export interface GpxTrackSummary {
  name?: string;
  description?: string;
  url?: string;
  point_count: number;
  bbox?: Bbox;
  first_time?: string;
  last_time?: string;
  /** Present only when requested; capped by max_points across all tracks. */
  points?: GpxPoint[];
}

export interface GpxSummary {
  tracks: GpxTrackSummary[];
  total_points: number;
  waypoints: number;
  points_returned?: number;
  points_truncated?: boolean;
}

const str = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));

/** Summarize GPX (any version) into compact JSON instead of dumping thousands of points into the model's context. */
export function summarizeGpx(xml: string, opts: { includePoints?: boolean; maxPoints?: number } = {}): GpxSummary {
  const root = parser.parse(xml);
  if (!root || typeof root !== "object" || !("gpx" in root)) throw new Error("Not a GPX document (no <gpx> root element).");
  const doc = root.gpx && typeof root.gpx === "object" ? root.gpx : {}; // `<gpx/>` parses to ""
  const max = opts.maxPoints ?? 200;
  let returned = 0;
  let total = 0;
  let truncated = false;
  const tracks: GpxTrackSummary[] = [];

  for (const trk of doc.trk ?? []) {
    const t: GpxTrackSummary = { name: str(trk.name), description: str(trk.desc), url: str(trk.url), point_count: 0 };
    const pts: GpxPoint[] = [];
    for (const seg of trk.trkseg ?? []) {
      for (const p of seg.trkpt ?? []) {
        const lat = Number(p["@_lat"]);
        const lon = Number(p["@_lon"]);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        t.point_count++;
        const time = str(p.time);
        t.bbox = t.bbox
          ? { min_lon: Math.min(t.bbox.min_lon, lon), min_lat: Math.min(t.bbox.min_lat, lat), max_lon: Math.max(t.bbox.max_lon, lon), max_lat: Math.max(t.bbox.max_lat, lat) }
          : { min_lon: lon, min_lat: lat, max_lon: lon, max_lat: lat };
        if (time) {
          if (!t.first_time || time < t.first_time) t.first_time = time;
          if (!t.last_time || time > t.last_time) t.last_time = time;
        }
        if (opts.includePoints) {
          if (returned < max) {
            const ele = p.ele !== undefined ? Number(p.ele) : undefined;
            pts.push({ lat, lon, ...(ele !== undefined && Number.isFinite(ele) ? { ele } : {}), ...(time ? { time } : {}) });
            returned++;
          } else truncated = true;
        }
      }
    }
    total += t.point_count;
    if (opts.includePoints) t.points = pts;
    tracks.push(t);
  }
  const out: GpxSummary = { tracks, total_points: total, waypoints: (doc.wpt ?? []).length };
  if (opts.includePoints) {
    out.points_returned = returned;
    out.points_truncated = truncated;
  }
  return out;
}
