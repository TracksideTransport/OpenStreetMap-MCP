import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Auth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Elicitation (#16): risky or public writes ask the user first, and decline/cancel never reach OSM. */
let osm: Server;
let base = "";
let hits: string[] = [];

beforeAll(async () => {
  osm = createHttp((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push(`${req.method} ${req.url}${req.url === "/api/0.6/gpx" ? ` ${body.match(/name="visibility"\r?\n\r?\n(\w+)/)?.[1]}` : ""}`);
      if (req.url === "/api/0.6/gpx") return void res.end("77");
      if (req.url?.startsWith("/api/0.6/changeset/5/upload")) return void res.end('<diffResult><node old_id="1" new_id="1" new_version="2"/></diffResult>');
      return void res.end("3");
    });
  });
  await new Promise<void>((r) => osm.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(osm.address() as AddressInfo).port}`;
});
afterAll(() => osm.close());
beforeEach(() => {
  hits = [];
});

type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

async function connect(answer: Answer | undefined, env: Record<string, string> = {}) {
  const cfg = loadConfig({ OSM_API_BASE: base, OSM_ACCESS_TOKEN: "tok", OSM_CONFIG_DIR: "/nonexistent-osm-mcp-test", ...env });
  const server = createServer(cfg, new Auth(cfg));
  const asked: { message: string; schema: any }[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  if (answer) {
    client.setRequestHandler("elicitation/create", async (req: any) => {
      asked.push({ message: req.params.message, schema: req.params.requestedSchema });
      return answer;
    });
  }
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: object) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content[0].text as string, isError: !!r.isError };
  };
  return { call, asked, close: () => client.close() };
}

const del = { changeset_id: 5, element: { type: "node", id: 1, version: 1, lat: 1, lon: 2 } };
const diffWithDelete = { changeset_id: 5, delete: [{ type: "node", id: 1, version: 1, lat: 1, lon: 2 }], modify: [{ type: "node", id: 2, version: 1, lat: 1, lon: 2 }] };
const gpx = { gpx: "<gpx><trk><trkseg><trkpt lat='1' lon='2'><time>2020-01-01T00:00:00Z</time></trkpt></trkseg></trk></gpx>", description: "A walk", visibility: "trackable" };

describe("confirmations through MCP elicitation", () => {
  it("deletes only after the user confirms, and says what will be deleted", async () => {
    const t = await connect({ action: "accept", content: { confirm: true } });
    const r = await t.call("osm_delete_element", del);
    expect(r.isError).toBe(false);
    expect(hits).toEqual(["DELETE /api/0.6/node/1"]);
    expect(t.asked[0].message).toMatch(/Delete node 1 \(version 1\)/);
    expect(t.asked[0].message).toMatch(/real OpenStreetMap/);
    await t.close();
  });

  it.each([
    ["decline", { action: "decline" }],
    ["cancel", { action: "cancel" }],
    ["accept with the box unticked", { action: "accept", content: { confirm: false } }],
  ] as [string, Answer][])("makes no request when the user does not confirm (%s)", async (_n, answer) => {
    const t = await connect(answer);
    for (const [tool, args] of [["osm_delete_element", del], ["osm_upload_diff", diffWithDelete], ["osm_delete_gpx", { id: 9 }]] as const) {
      const r = await t.call(tool, args);
      expect(r.isError).toBe(false);
      expect(JSON.parse(r.text).cancelled).toBe(true);
    }
    expect(hits).toEqual([]);
    await t.close();
  });

  it("asks about an osmChange upload only when it deletes, with counts", async () => {
    const t = await connect({ action: "accept", content: { confirm: true } });
    await t.call("osm_upload_diff", { changeset_id: 5, modify: [{ type: "node", id: 2, version: 1, lat: 1, lon: 2 }] });
    expect(t.asked).toHaveLength(0);
    await t.call("osm_upload_diff", diffWithDelete);
    expect(t.asked).toHaveLength(1);
    expect(t.asked[0].message).toMatch(/0 create, 1 modify, 1 DELETE/);
    await t.close();
  });

  it("lets the user choose GPX visibility; their choice beats the model's", async () => {
    const t = await connect({ action: "accept", content: { visibility: "identifiable" } });
    const r = await t.call("osm_upload_gpx", gpx);
    expect(JSON.parse(r.text).visibility).toBe("identifiable");
    expect(hits).toEqual(["POST /api/0.6/gpx identifiable"]);
    expect(t.asked[0].schema.properties.visibility.enum).toEqual(["trackable", "identifiable"]);
    expect(t.asked[0].schema.properties.visibility.default).toBe("trackable");
    await t.close();
  });

  it("uploads nothing when the GPX visibility prompt is declined", async () => {
    const t = await connect({ action: "decline" });
    const r = await t.call("osm_upload_gpx", gpx);
    expect(JSON.parse(r.text).cancelled).toBe(true);
    expect(hits).toEqual([]);
    await t.close();
  });

  it("falls back to the old behaviour when the client cannot elicit", async () => {
    const t = await connect(undefined);
    expect((await t.call("osm_delete_element", del)).isError).toBe(false);
    expect(hits).toEqual(["DELETE /api/0.6/node/1"]);
    await t.close();
  });

  it("OSM_CONFIRM_WRITES=off skips the prompt even when the client can elicit", async () => {
    const t = await connect({ action: "decline" }, { OSM_CONFIRM_WRITES: "off" });
    expect((await t.call("osm_delete_element", del)).isError).toBe(false);
    expect(t.asked).toHaveLength(0);
    expect(hits).toEqual(["DELETE /api/0.6/node/1"]);
    await t.close();
  });

  it("does not prompt for ordinary small edits", async () => {
    const t = await connect({ action: "decline" });
    await t.call("osm_create_changeset", { comment: "x" });
    expect(t.asked).toHaveLength(0);
    await t.close();
  });
});
