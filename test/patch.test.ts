import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { OsmClient } from "../src/osm.js";
import { patchTags } from "../src/patch.js";

const elements: Record<string, object> = {
  "node/1": { type: "node", id: 1, version: 3, lat: 1.5, lon: -2.5, tags: { amenity: "cafe", name: "Old", wifi: "yes" } },
  "way/2": { type: "way", id: 2, version: 7, nodes: [10, 11, 12], tags: { highway: "path" } },
  "relation/3": { type: "relation", id: 3, version: 2, members: [{ type: "way", ref: 2, role: "outer" }], tags: { type: "multipolygon" } },
};
let srv: Server;
let base = "";
let puts: { url?: string; body: string }[] = [];

beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = req.url?.match(/^\/api\/0\.6\/(node|way|relation)\/(\d+)(\.json)?$/);
      if (req.method === "GET" && m && elements[`${m[1]}/${m[2]}`]) return void res.end(JSON.stringify({ elements: [elements[`${m[1]}/${m[2]}`]] }));
      if (req.method === "PUT" && m) {
        puts.push({ url: req.url, body });
        return void res.end(String((elements[`${m[1]}/${m[2]}`] as { version: number }).version + 1));
      }
      res.writeHead(404).end("not found");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());
beforeEach(() => (puts = []));

const osm = () => {
  const cfg = loadConfig({ OSM_API_BASE: base, OSM_ACCESS_TOKEN: "tok" });
  return new OsmClient(cfg, new Auth(cfg));
};

describe("patchTags", () => {
  it("merges set/remove on a node and preserves geometry and other tags", async () => {
    const r = await patchTags(osm(), { changeset_id: 9, type: "node", id: 1, set: { name: "New", cuisine: "coffee" }, remove: ["wifi"] });
    expect(r).toMatchObject({ changed: true, version: 4, new_tags: { amenity: "cafe", name: "New", cuisine: "coffee" } });
    expect(r.old_tags.name).toBe("Old");
    expect(puts).toHaveLength(1);
    const b = puts[0].body;
    expect(b).toContain('<node id="1" version="3" changeset="9" lat="1.5" lon="-2.5">');
    expect(b).toContain('<tag k="amenity" v="cafe"/>');
    expect(b).not.toContain("wifi");
  });

  it("preserves way node refs", async () => {
    await patchTags(osm(), { changeset_id: 9, type: "way", id: 2, set: { surface: "gravel" } });
    expect(puts[0].body.match(/<nd ref="\d+"\/>/g)).toEqual(['<nd ref="10"/>', '<nd ref="11"/>', '<nd ref="12"/>']);
  });

  it("preserves relation members and roles", async () => {
    await patchTags(osm(), { changeset_id: 9, type: "relation", id: 3, set: { name: "x" } });
    expect(puts[0].body).toContain('<member type="way" ref="2" role="outer"/>');
  });

  it("does not write when tags are unchanged and reports ignored removals", async () => {
    const r = await patchTags(osm(), { changeset_id: 9, type: "node", id: 1, set: { amenity: "cafe" }, remove: ["nope"] });
    expect(r).toMatchObject({ changed: false, version: 3, ignored_remove: ["nope"] });
    expect(puts).toHaveLength(0);
  });

  it("fails on version mismatch without writing", async () => {
    await expect(patchTags(osm(), { changeset_id: 9, type: "node", id: 1, set: { a: "b" }, expected_version: 2 })).rejects.toThrow(/Version conflict.*version 3, expected 2/);
    expect(puts).toHaveLength(0);
  });

  it("rejects empty input and set/remove overlap", async () => {
    await expect(patchTags(osm(), { changeset_id: 9, type: "node", id: 1 })).rejects.toThrow(/Nothing to do/);
    await expect(patchTags(osm(), { changeset_id: 9, type: "node", id: 1, set: { a: "1" }, remove: ["a"] })).rejects.toThrow(/both set and remove/);
  });

  it("reports missing elements", async () => {
    await expect(patchTags(osm(), { changeset_id: 9, type: "node", id: 999, set: { a: "b" } })).rejects.toThrow(/404/);
  });
});
