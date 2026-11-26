import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hermeticEnv, startServer, type TestServer } from "./helpers/server.js";

interface Seen { method?: string; url?: string; auth?: string; ctype?: string; accept?: string; body: string }
let srv: Server;
let base = "";
let seen: Seen[] = [];
let s: TestServer;

const GPX = '<gpx version="1.0"><trk><name>t</name><trkseg><trkpt lat="51.6" lon="0.05"><time>2020-01-01T00:00:00Z</time></trkpt><trkpt lat="51.7" lon="0.06"/></trkseg></trk></gpx>';

beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, ctype: req.headers["content-type"], accept: String(req.headers.accept), body });
      const u = new URL(req.url!, "http://x");
      const p = u.pathname.replace("/api/0.6", "");
      const json = (o: unknown) => void res.setHeader("content-type", "application/json").end(JSON.stringify(o));
      if (p === "/trackpoints") return void res.end(GPX);
      if (p === "/gpx/5/data.gpx") return void res.end(GPX);
      if (p === "/gpx/5.json") return json({ gpx_file: { id: 5, name: "t.gpx", visibility: "private", description: "old desc", tags: ["a", "b"] } });
      if (p === "/user/gpx_files.json") return json({ gpx_files: [{ id: 5 }] });
      if (req.method === "POST" && p === "/gpx") return void res.end("77");
      if (req.method === "PUT" && p === "/gpx/5") return void res.end("");
      if (req.method === "DELETE" && p === "/gpx/5") return void res.end("");
      if (p === "/user/preferences.json") return json({ preferences: { k: "v" } });
      if (req.method === "GET" && p === "/user/preferences/some%20key") return void res.end("the value");
      if (req.method === "PUT" && p === "/user/preferences/some%20key") return void res.end("");
      if (req.method === "DELETE" && p === "/user/preferences/some%20key") return void res.end("");
      res.writeHead(403).end("scope missing");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  s = await startServer({ ...hermeticEnv, OSM_API_BASE: base, OSM_ACCESS_TOKEN: "tok" });
}, 30_000);
afterAll(() => {
  s?.close();
  srv.close();
});
beforeEach(() => (seen = []));

describe("GPX tools", () => {
  it("osm_get_trackpoints summarizes and validates the bbox", async () => {
    const r = await s.call("osm_get_trackpoints", { min_lon: 0, min_lat: 51.5, max_lon: 0.2, max_lat: 51.7, page: 1, include_points: true });
    expect(r).toMatchObject({ page: 1, has_more: false, total_points: 2, tracks: [{ name: "t", point_count: 2 }] });
    expect(r.tracks[0].points).toHaveLength(2);
    expect(new URL(seen[0].url!, "http://x").searchParams.get("bbox")).toBe("0,51.5,0.2,51.7");
    const big = await s.raw("osm_get_trackpoints", { min_lon: 0, min_lat: 0, max_lon: 1, max_lat: 1 });
    expect(big.isError).toBe(true);
    expect(big.content[0].text).toMatch(/too large/);
    expect(seen).toHaveLength(1); // the oversized request never went out
  });

  it("osm_get_gpx_data returns a summary by default and raw GPX on request", async () => {
    expect((await s.call("osm_get_gpx_data", { id: 5 })).total_points).toBe(2);
    expect(await s.call("osm_get_gpx_data", { id: 5, format: "gpx" })).toContain("<gpx");
  });

  it("osm_list_my_gpx_files and osm_get_gpx_details", async () => {
    expect((await s.call("osm_list_my_gpx_files")).gpx_files[0].id).toBe(5);
    expect((await s.call("osm_get_gpx_details", { id: 5 })).gpx_file.description).toBe("old desc");
    expect(seen[0].auth).toBe("Bearer tok");
  });

  it("osm_upload_gpx sends multipart with a private default", async () => {
    const r = await s.call("osm_upload_gpx", { gpx: GPX, description: "my ride", tags: ["bike", "test"] });
    expect(r).toMatchObject({ gpx_id: 77, visibility: "private" });
    const up = seen.find((x) => x.method === "POST")!;
    expect(up.ctype).toMatch(/^multipart\/form-data; boundary=/);
    expect(up.auth).toBe("Bearer tok");
    expect(up.body).toContain('name="description"');
    expect(up.body).toContain("my ride");
    expect(up.body).toContain("bike,test");
    expect(up.body).toMatch(/name="visibility"\r\n\r\nprivate/);
    expect(up.body).toMatch(/name="file"; filename="track.gpx"/);
    expect(up.body).toContain("<trkpt");
  });

  it("osm_update_gpx merges with current metadata and PUTs XML", async () => {
    const r = await s.call("osm_update_gpx", { id: 5, visibility: "public", tags: ["x"] });
    expect(r).toMatchObject({ id: 5, visibility: "public", description: "old desc", tags: ["x"] });
    const put = seen.find((x) => x.method === "PUT")!;
    expect(put.body).toBe('<osm><gpx_file name="t.gpx" visibility="public"><description>old desc</description><tag>x</tag></gpx_file></osm>');
    expect((await s.raw("osm_update_gpx", { id: 5 })).isError).toBe(true);
  });

  it("osm_delete_gpx deletes", async () => {
    expect(await s.call("osm_delete_gpx", { id: 5 })).toEqual({ deleted: 5 });
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: "/api/0.6/gpx/5" });
  });
});

describe("preference tools", () => {
  it("reads all and one (key is URL-encoded)", async () => {
    expect((await s.call("osm_get_preferences")).preferences).toEqual({ k: "v" });
    expect(await s.call("osm_get_preferences", { key: "some key" })).toEqual({ key: "some key", value: "the value" });
  });

  it("sets with a plain-text body and deletes", async () => {
    expect(await s.call("osm_set_preference", { key: "some key", value: "hello" })).toEqual({ key: "some key", value: "hello" });
    const put = seen.find((x) => x.method === "PUT")!;
    expect(put).toMatchObject({ url: "/api/0.6/user/preferences/some%20key", body: "hello" });
    expect(put.ctype).toBe("text/plain");
    expect(await s.call("osm_delete_preference", { key: "some key" })).toEqual({ deleted: "some key" });
  });

  it("surfaces a missing-scope 403 as a readable error", async () => {
    const r = await s.raw("osm_get_preferences", { key: "other" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/403.*scope/);
  });
});
