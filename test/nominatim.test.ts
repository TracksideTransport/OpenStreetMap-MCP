import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Nominatim, toBbox } from "../src/nominatim.js";

let srv: Server;
let base = "";
let hits: { url: string; ua?: string; at: number }[] = [];

beforeAll(async () => {
  srv = createServer((req, res) => {
    hits.push({ url: req.url!, ua: req.headers["user-agent"], at: Date.now() });
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/search" && u.searchParams.get("q") === "blocked") return void res.writeHead(429).end("slow down");
    if (u.pathname === "/search")
      return void res.end(JSON.stringify([{ display_name: "Fenway Park, Boston", lat: "42.3467", lon: "-71.0972", osm_type: "way", osm_id: 96092778, category: "leisure", type: "stadium", importance: 0.5, boundingbox: ["42.3440", "42.3490", "-71.1010", "-71.0950"], address: { city: "Boston" } }]));
    if (u.pathname === "/reverse" && u.searchParams.get("lat") === "0") return void res.end('{"error":"Unable to geocode"}');
    if (u.pathname === "/reverse") return void res.end(JSON.stringify({ display_name: "Somewhere", lat: "1", lon: "2", osm_type: "node", osm_id: 5, boundingbox: ["0.9", "1.1", "1.9", "2.1"] }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());
beforeEach(() => (hits = []));

describe("Nominatim client", () => {
  it("converts [S,N,W,E] boxes to min/max lon/lat", () => {
    expect(toBbox(["1", "2", "3", "4"])).toEqual({ min_lon: 3, min_lat: 1, max_lon: 4, max_lat: 2 });
    expect(toBbox(["x", "2", "3", "4"])).toBeUndefined();
    expect(toBbox(undefined)).toBeUndefined();
  });

  it("searches with an identifying User-Agent and maps results", async () => {
    const n = new Nominatim(base, "test-agent/1.0 (+https://example.test)", { minIntervalMs: 0 });
    const r = await n.search({ query: "Fenway Park", limit: 3, country_codes: ["US"], language: "en" });
    expect(r[0]).toMatchObject({ display_name: "Fenway Park, Boston", lat: 42.3467, lon: -71.0972, osm_type: "way", osm_id: 96092778, bbox: { min_lon: -71.101, min_lat: 42.344, max_lon: -71.095, max_lat: 42.349 } });
    expect(hits[0].ua).toBe("test-agent/1.0 (+https://example.test)");
    const q = new URL(hits[0].url, "http://x").searchParams;
    expect(q.get("limit")).toBe("3");
    expect(q.get("countrycodes")).toBe("us");
    expect(q.get("accept-language")).toBe("en");
    expect(q.get("format")).toBe("jsonv2");
  });

  it("sends viewbox as left,top,right,bottom and clamps limit to 10", async () => {
    const n = new Nominatim(base, "ua", { minIntervalMs: 0 });
    await n.search({ query: "cafe", limit: 99, viewbox: { min_lon: 1, min_lat: 2, max_lon: 3, max_lat: 4 }, bounded: true });
    const q = new URL(hits[0].url, "http://x").searchParams;
    expect(q.get("viewbox")).toBe("1,4,3,2");
    expect(q.get("bounded")).toBe("1");
    expect(q.get("limit")).toBe("10");
  });

  it("caches identical requests", async () => {
    const n = new Nominatim(base, "ua", { minIntervalMs: 0 });
    await n.search({ query: "cache me" });
    await n.search({ query: "cache me" });
    expect(hits).toHaveLength(1);
  });

  it("spaces distinct requests by the minimum interval, even when fired together", async () => {
    const n = new Nominatim(base, "ua", { minIntervalMs: 120 });
    await Promise.all([n.search({ query: "a1" }), n.search({ query: "a2" }), n.search({ query: "a3" })]);
    expect(hits).toHaveLength(3);
    expect(hits[1].at - hits[0].at).toBeGreaterThanOrEqual(110);
    expect(hits[2].at - hits[1].at).toBeGreaterThanOrEqual(110);
  });

  it("reverse geocodes and returns null when nothing is found", async () => {
    const n = new Nominatim(base, "ua", { minIntervalMs: 0 });
    expect((await n.reverse({ lat: 1, lon: 2 }))?.display_name).toBe("Somewhere");
    expect(await n.reverse({ lat: 0, lon: 0 })).toBeNull();
  });

  it("explains rate limiting errors and does not cache failures", async () => {
    const n = new Nominatim(base, "ua", { minIntervalMs: 0 });
    await expect(n.search({ query: "blocked" })).rejects.toThrow(/429.*usage policy/);
    await expect(n.search({ query: "blocked" })).rejects.toThrow(/429/);
    expect(hits).toHaveLength(2);
  });
});

describe("config", () => {
  it("geocoding is opt-in and the service URL is overridable", () => {
    expect(loadConfig({}).enableGeocoding).toBe(false);
    expect(loadConfig({ OSM_ENABLE_GEOCODING: "true" }).enableGeocoding).toBe(true);
    expect(loadConfig({ OSM_ENABLE_GEOCODING: "0" }).enableGeocoding).toBe(false);
    expect(loadConfig({}).nominatimBase).toBe("https://nominatim.openstreetmap.org");
    expect(loadConfig({ OSM_NOMINATIM_URL: "http://localhost:8080/" }).nominatimBase).toBe("http://localhost:8080");
  });
});
