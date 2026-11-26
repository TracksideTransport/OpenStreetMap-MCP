import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { OsmClient, OsmError } from "../src/osm.js";

let srv: Server;
let base = "";
const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];

beforeAll(async () => {
  srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url?.startsWith("/api/0.6/node/1.json")) return void res.end('{"elements":[{"type":"node","id":1}]}');
      if (req.url === "/api/0.6/changeset/create") return void res.end("123");
      if (req.url === "/api/0.6/way/9") return void res.writeHead(409).end("Version mismatch");
      res.writeHead(404).end("nope");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
});
afterAll(() => srv.close());

const mk = (token?: string) => {
  const cfg = loadConfig({ OSM_API_BASE: base, OSM_ACCESS_TOKEN: token });
  return new OsmClient(cfg, new Auth(cfg));
};

describe("OsmClient", () => {
  it("reads json without auth", async () => {
    const j = await mk().getJson("/node/1.json");
    expect(j.elements[0].id).toBe(1);
    expect(seen.at(-1)?.auth).toBeUndefined();
  });

  it("attaches bearer token on writes and returns text", async () => {
    const out = await mk("tok").send("PUT", "/changeset/create", { body: "<osm/>" });
    expect(out).toBe("123");
    expect(seen.at(-1)?.auth).toBe("Bearer tok");
    expect(seen.at(-1)?.body).toBe("<osm/>");
  });

  it("refuses writes without a token", async () => {
    await expect(mk().send("PUT", "/changeset/create", { body: "<osm/>" })).rejects.toThrow(/osm_login/);
  });

  it("maps HTTP errors to helpful messages", async () => {
    const err = await mk("tok").send("PUT", "/way/9", { body: "<osm/>" }).catch((e) => e);
    expect(err).toBeInstanceOf(OsmError);
    expect(err.message).toMatch(/409.*stale/);
  });
});
