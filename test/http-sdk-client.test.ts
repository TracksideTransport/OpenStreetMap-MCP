import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createHttpApp } from "../src/http/app.js";

/**
 * Compatibility check: the official MCP SDK client must be able to discover, register, authorize (PKCE),
 * and call tools on our HTTP server on its own. OpenStreetMap is mocked; the "browser" is simulated with fetch.
 */
let osm: Server;
let http: Server;
let base = "";
const osmAuth: (string | undefined)[] = [];

beforeAll(async () => {
  osm = createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/oauth2/authorize") {
      const back = new URL(u.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "osmcode-1");
      back.searchParams.set("state", u.searchParams.get("state")!);
      return void res.writeHead(302, { location: back.toString() }).end();
    }
    if (u.pathname === "/oauth2/token") return void res.setHeader("content-type", "application/json").end(JSON.stringify({ access_token: "osm-secret-token", scope: "read_prefs write_api" }));
    if (u.pathname === "/api/0.6/user/details.json") {
      osmAuth.push(req.headers.authorization);
      return void res.setHeader("content-type", "application/json").end(JSON.stringify({ user: { id: 7, display_name: "tester" } }));
    }
    if (u.pathname === "/api/0.6/permissions.json") return void res.setHeader("content-type", "application/json").end('{"permissions":["allow_write_api"]}');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => osm.listen(0, "127.0.0.1", r));
  const osmBase = `http://127.0.0.1:${(osm.address() as AddressInfo).port}`;

  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  const cfg = loadConfig({ OSM_CLIENT_ID: "c", OSM_API_BASE: osmBase, OSM_WEB_BASE: osmBase, OSM_HTTP_PORT: String(port), OSM_PUBLIC_URL: `http://127.0.0.1:${port}`, OSM_CONFIG_DIR: "/nonexistent" });
  http = createHttpApp(cfg).app.listen(port, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  base = cfg.http.publicUrl;
});
afterAll(() => {
  http?.close();
  osm?.close();
});

class Provider {
  readonly redirectUrl = "http://127.0.0.1:8090/callback";
  readonly clientMetadata = { client_name: "SDK test client", redirect_uris: ["http://127.0.0.1:8090/callback"], application_type: "native" as const };
  creds = new Map<string, any>();
  saved?: any;
  verifier?: string;
  discovery?: any;
  lastState?: string;
  authorizeUrl?: URL;
  clientInformation(ctx?: { issuer: string }) { return ctx ? this.creds.get(ctx.issuer) : undefined; }
  saveClientInformation(info: any, ctx?: { issuer: string }) { if (ctx) this.creds.set(ctx.issuer, info); }
  tokens() { return this.saved; }
  saveTokens(t: any) { this.saved = t; }
  state() { return (this.lastState = crypto.randomUUID()); }
  saveDiscoveryState(s: any) { this.discovery = s; }
  discoveryState() { return this.discovery; }
  redirectToAuthorization(url: URL) { this.authorizeUrl = url; }
  saveCodeVerifier(v: string) { this.verifier = v; }
  codeVerifier() { if (!this.verifier) throw new Error("no verifier"); return this.verifier; }
}

/** What the user's browser does: open the authorize URL, approve our consent page, "log in" at OSM, come back. */
async function browser(authorizeUrl: URL): Promise<URLSearchParams> {
  const page = await fetch(authorizeUrl, { redirect: "manual" });
  expect(page.status).toBe(200);
  const cookie = page.headers.get("set-cookie")!.split(";")[0];
  const txn = /name="txn" value="([^"]+)"/.exec(await page.text())![1];
  const consent = await fetch(`${base}/authorize/consent`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ txn, action: "approve" }) });
  const viaOsm = await fetch(consent.headers.get("location")!, { redirect: "manual" });
  const back = await fetch(viaOsm.headers.get("location")!, { redirect: "manual", headers: { cookie } });
  expect(back.status).toBe(302);
  return new URL(back.headers.get("location")!).searchParams;
}

describe("official MCP SDK client against the HTTP server", () => {
  it("discovers, registers, authorizes with PKCE, and calls tools", async () => {
    const provider = new Provider();
    const url = new URL(`${base}/mcp`);
    const first = new Client({ name: "sdk-test", version: "0" });
    // 1. unauthenticated connect: 401 -> discovery -> dynamic registration -> redirect to /authorize
    await expect(first.connect(new StreamableHTTPClientTransport(url, { authProvider: provider as never }))).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.authorizeUrl).toBeDefined();
    const q = provider.authorizeUrl!.searchParams;
    expect(provider.authorizeUrl!.origin + provider.authorizeUrl!.pathname).toBe(`${base}/authorize`);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(`${base}/mcp`);
    expect(provider.creds.size).toBe(1);

    // 2. the user approves in the browser; the client finishes the code exchange
    const params = await browser(provider.authorizeUrl!);
    expect(params.get("state")).toBe(provider.lastState);
    const transport = new StreamableHTTPClientTransport(url, { authProvider: provider as never });
    await transport.finishAuth(params);
    expect(provider.saved?.access_token).toBeTruthy();
    expect(provider.saved.access_token).not.toBe("osm-secret-token"); // the OSM token never leaves the server

    // 3. a fresh transport now works and tools run as the user
    const client = new Client({ name: "sdk-test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(url, { authProvider: provider as never }));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("osm_get_element");
    expect(names).not.toContain("osm_login");
    const who: any = await client.callTool({ name: "osm_whoami", arguments: {} });
    expect(JSON.parse(who.content[0].text)).toMatchObject({ authenticated: true });
    expect(osmAuth.at(-1)).toBe("Bearer osm-secret-token");
    await client.close();
  }, 30_000);
});
