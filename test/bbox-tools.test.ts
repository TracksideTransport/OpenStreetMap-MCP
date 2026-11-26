import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { hermeticEnv, startServer, type TestServer } from "./helpers/server.js";

/** A dense urban box: mostly untagged nodes (some far outside the box), many ways, a few tagged entrances at the END. */
function denseMap() {
  const elements: any[] = [];
  for (let i = 1; i <= 3000; i++) {
    const far = i % 10 === 0; // every 10th node belongs to a way that leaves the box
    elements.push({ type: "node", id: i, lat: far ? 42.40 : 42.374, lon: far ? -71.02 : -71.0301, version: 5, timestamp: "2024-05-05T10:00:00Z", changeset: 12345678, uid: 99, user: "someone" });
  }
  for (let i = 1; i <= 20; i++) {
    elements.push({ type: "node", id: 10_000 + i, lat: 42.3741, lon: -71.0302, version: 2, timestamp: "2024-05-05T10:00:00Z", changeset: 1, uid: 99, user: "someone", tags: { railway: "subway_entrance", ref: String(i) } });
  }
  for (let i = 1; i <= 400; i++) elements.push({ type: "way", id: 50_000 + i, nodes: [i, i + 1, i + 2], version: 3, timestamp: "2024-05-05T10:00:00Z", changeset: 1, uid: 99, user: "someone", tags: i % 50 === 0 ? { highway: "elevator" } : { building: "yes" } });
  for (let i = 1; i <= 5; i++) elements.push({ type: "relation", id: 90_000 + i, members: [{ type: "way", ref: 50_001, role: "outer" }], version: 1, timestamp: "2024-05-05T10:00:00Z", changeset: 1, uid: 99, user: "someone", tags: { public_transport: "stop_area" } });
  return { version: "0.6", generator: "mock-cgimap", elements };
}

let osm: Server;
let s: TestServer;
const BOX = { min_lon: -71.030956, min_lat: 42.373484, max_lon: -71.029381, max_lat: 42.375053 };

beforeAll(async () => {
  const map = JSON.stringify(denseMap());
  osm = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/api/0.6/map.json") return void res.setHeader("content-type", "application/json").end(map);
    if (u.pathname === "/api/0.6/capabilities.json") return void res.setHeader("content-type", "application/json").end('{"version":"0.6","api":{"area":{"maximum":0.25}}}');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => osm.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(osm.address() as AddressInfo).port}`;
  s = await startServer({ ...hermeticEnv, OSM_API_BASE: base });
}, 30_000);
afterAll(() => {
  s?.close();
  osm?.close();
});

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("osm_get_bbox on a dense area (issue #17)", () => {
  it("the raw map is far bigger than the output cap, as in the report", () => {
    expect(JSON.stringify(denseMap(), null, 2).length).toBeGreaterThan(600_000);
  });

  it("an unfiltered call is complete valid JSON under the cap, with paging info (no mid-element cut)", async () => {
    const r = await s.raw("osm_get_bbox", BOX);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.length).toBeLessThanOrEqual(60_000);
    const out = parse(r); // would throw on truncated JSON
    expect(out.total_in_area).toBe(3425);
    expect(out.returned).toBeGreaterThan(50);
    expect(out.returned).toBeLessThanOrEqual(200);
    expect(out.next_offset).toBe(out.returned);
    expect(out.elements.every((e: any) => e.type && typeof e.id === "number")).toBe(true);
    expect(out.truncated).toBeUndefined(); // the page was sized to fit, nothing was dropped after the fact
  });

  it("a tag filter reaches the entrances that sit past any size cap", async () => {
    const out = parse(await s.raw("osm_get_bbox", { ...BOX, tag_filters: ["railway=subway_entrance"], compact: true }));
    expect(out.total_matching).toBe(20);
    expect(out.returned).toBe(20);
    expect(out.next_offset).toBeNull();
    expect(out.elements.map((e: any) => e.tags.ref)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    expect(out.elements[0]).not.toHaveProperty("user");
  });

  it("combines filters: elevators OR entrances, nodes and ways", async () => {
    const out = parse(await s.raw("osm_get_bbox", { ...BOX, tag_filters: ["railway=subway_entrance", "highway=elevator"], compact: true }));
    expect(out.total_matching).toBe(20 + 8);
    expect(parse(await s.raw("osm_get_bbox", { ...BOX, tag_filters: ["highway=elevator"], types: ["node"] })).total_matching).toBe(0);
    expect(parse(await s.raw("osm_get_bbox", { ...BOX, types: ["relation"] })).total_matching).toBe(5);
  });

  it("inside_bbox_only drops the far-away nodes the API pulls in", async () => {
    const all = parse(await s.raw("osm_get_bbox", { ...BOX, types: ["node"], limit: 2000, compact: true }));
    const inside = parse(await s.raw("osm_get_bbox", { ...BOX, types: ["node"], inside_bbox_only: true, limit: 2000, compact: true }));
    expect(all.total_matching).toBe(3020);
    expect(inside.total_matching).toBe(3020 - 300);
    expect(inside.elements.every((e: any) => e.lat <= BOX.max_lat && e.lat >= BOX.min_lat)).toBe(true);
  });

  it("paging walks the whole filtered result in small complete pages", async () => {
    const ids: number[] = [];
    let offset = 0;
    for (let guard = 0; guard < 10; guard++) {
      const out = parse(await s.raw("osm_get_bbox", { ...BOX, tag_filters: ["railway"], limit: 7, offset, compact: true }));
      ids.push(...out.elements.map((e: any) => e.id));
      if (out.next_offset === null) break;
      offset = out.next_offset;
    }
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => 10_001 + i));
  });

  it("tagged_only skips the untagged way nodes", async () => {
    const out = parse(await s.raw("osm_get_bbox", { ...BOX, tagged_only: true, types: ["node"], compact: true }));
    expect(out.total_matching).toBe(20);
  });
});

describe("version reporting (issue #18)", () => {
  it("VERSION is read from package.json, so the two cannot drift", () => {
    expect(VERSION).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("osm_capabilities reports the package version next to the API limits", async () => {
    const caps = parse(await s.raw("osm_capabilities"));
    expect(caps.mcp).toMatchObject({ name: "openstreetmap-mcp", version: VERSION, environment: "production" });
    expect(caps.mcp.api).toMatch(/^http/);
    expect(caps.api.area.maximum).toBe(0.25); // the OSM API's own fields are untouched
  });

  it("osm_whoami reports it too, even when not signed in", async () => {
    const who = parse(await s.raw("osm_whoami"));
    expect(who).toMatchObject({ server: { name: "openstreetmap-mcp", version: VERSION }, authenticated: false });
  });

  it("the MCP handshake reports the same version", async () => {
    const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.result.serverInfo).toEqual({ name: "openstreetmap-mcp", version: VERSION });
  });
});
