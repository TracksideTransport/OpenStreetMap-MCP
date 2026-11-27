import { createServer as createHttp, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Auth } from "../../src/auth.js";
import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

/** A tiny fake OSM API that records every request, so tests can assert that nothing was sent. */
export async function startOsmMock() {
  const hits: string[] = [];
  /** Request bodies, in the same order as `hits` */
  const bodies: string[] = [];
  const srv: Server = createHttp((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      hits.push(`${req.method} ${req.url}${req.url === "/api/0.6/gpx" ? ` ${body.match(/name="visibility"\r?\n\r?\n(\w+)/)?.[1]}` : ""}`);
      if (req.url === "/api/0.6/gpx") return void res.end("77");
      if (req.url?.startsWith("/api/0.6/changeset/5/upload")) return void res.end('<diffResult><node old_id="1" new_id="1" new_version="2"/></diffResult>');
      return void res.end("3");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits, bodies, close: () => srv.close() };
}

export type Answer = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

/** The real server and the official SDK client over an in-memory transport. Without `answer` the client cannot elicit. */
export async function connectClient(base: string, answer: Answer | ((req: any) => Answer) | undefined, env: Record<string, string> = {}) {
  const cfg = loadConfig({ OSM_API_BASE: base, OSM_ACCESS_TOKEN: "tok", OSM_CONFIG_DIR: "/nonexistent-osm-mcp-test", ...env });
  const server = createServer(cfg, new Auth(cfg));
  const asked: { message: string; schema: any }[] = [];
  const client = new Client({ name: "t", version: "0" }, { capabilities: answer ? { elicitation: { form: {} } } : {} });
  if (answer) {
    client.setRequestHandler("elicitation/create", async (req: any) => {
      asked.push({ message: req.params.message, schema: req.params.requestedSchema });
      return typeof answer === "function" ? answer(req) : answer;
    });
  }
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  const call = async (name: string, args: object) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { text: r.content[0].text as string, isError: !!r.isError, json: () => JSON.parse(r.content[0].text) };
  };
  return { call, asked, close: () => client.close() };
}
