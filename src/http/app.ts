import type { Server } from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { createMcpExpressApp, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter, requireBearerAuth } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { AuthLike } from "../auth.js";
import type { Config } from "../config.js";
import { createHash } from "node:crypto";
import { WriteGuard } from "../guard.js";
import { createServer } from "../server.js";
import { VERSION } from "../version.js";
import type { SkillsCatalog } from "../skills.js";
import { consentPage, errorPage } from "./page.js";
import { OAuthHttpError, OAuthProxy } from "./proxy.js";
import { TtlMap } from "./store.js";

const COOKIE = "mcp_txn";
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Per-request auth: the OSM token behind the caller's MCP access token. */
export class RequestAuth implements AuthLike {
  constructor(private proxy: OAuthProxy, private accessToken: string) {}
  async getToken() {
    return this.proxy.session(this.accessToken)?.osmToken;
  }
  async requireToken(): Promise<string> {
    const t = await this.getToken();
    if (!t) throw new Error("Your session expired. Reconnect the MCP server to sign in again.");
    return t;
  }
  scopes() {
    return this.proxy.session(this.accessToken)?.osmScope;
  }
  logout() {
    return this.proxy.revoke(this.accessToken);
  }
}

/** Fail fast on settings that would make the server insecure or unusable. */
export function assertHttpConfig(cfg: Config): void {
  if (!cfg.clientId) throw new Error("OSM_CLIENT_ID is required for --http: register an OSM OAuth 2 app with redirect URI <OSM_PUBLIC_URL>/oauth/callback.");
  let u: URL;
  try {
    u = new URL(cfg.http.publicUrl);
  } catch {
    throw new Error(`OSM_PUBLIC_URL is not a valid URL: ${cfg.http.publicUrl}`);
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.has(u.hostname))) {
    throw new Error("OSM_PUBLIC_URL must be https (terminate TLS in front of this server); plain http is only allowed for localhost.");
  }
}

export function createHttpApp(cfg: Config, proxy = new OAuthProxy(cfg), skills?: SkillsCatalog) {
  assertHttpConfig(cfg);
  const publicUrl = new URL(cfg.http.publicUrl);
  const secure = publicUrl.protocol === "https:";
  const allowedHosts = [publicUrl.hostname, "localhost", "127.0.0.1", "[::1]", ...cfg.http.allowedHosts];
  const app = createMcpExpressApp({ host: cfg.http.host, allowedHosts });
  app.disable("x-powered-by");
  const form = express.urlencoded({ extended: false, limit: "8kb" });

  const noStore = (res: Response) => void res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });
  const html = (res: Response, status: number, body: string) =>
    void res
      .status(status)
      .set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
      .send(body);
  const cookieTxn = (req: Request) => (req.headers.cookie ?? "").split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const setCookie = (res: Response, value: string, maxAge: number) =>
    void res.append("Set-Cookie", `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`);
  const wrap = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

  // Discovery: RFC 9728 protected resource metadata (+ mirrored RFC 8414 authorization server metadata).
  app.use(mcpAuthMetadataRouter({ oauthMetadata: proxy.metadata() as never, resourceServerUrl: new URL(proxy.resource) }));
  app.get("/healthz", (_req, res) => void res.json({ ok: true, version: VERSION }));

  app.post("/register", (req, res) => {
    noStore(res);
    res.status(201).json(proxy.registerClient(req.body));
  });

  app.get("/authorize", (req, res) => {
    const q = new URLSearchParams(Object.entries(req.query).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    const r = proxy.beginAuthorize(q);
    if (r.kind === "page-error") return html(res, 400, errorPage(r.message));
    if (r.kind === "redirect") return void res.redirect(302, r.url);
    setCookie(res, r.txnId, 600);
    html(res, 200, consentPage({ ...r, serverUrl: proxy.issuer }));
  });

  app.post("/authorize/consent", form, (req, res) => {
    const txn = typeof req.body?.txn === "string" ? req.body.txn : "";
    const url = proxy.consent(txn, cookieTxn(req), req.body?.action === "approve");
    if (req.body?.action !== "approve") setCookie(res, "", 0);
    res.redirect(302, url);
  });

  app.get("/oauth/callback", wrap(async (req, res) => {
    const params = new URLSearchParams(Object.entries(req.query).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
    const url = await proxy.complete(params, cookieTxn(req));
    setCookie(res, "", 0);
    res.redirect(302, url);
  }));

  app.post("/token", form, (req, res) => {
    noStore(res);
    res.json(proxy.token(new URLSearchParams(req.body as Record<string, string>)));
  });

  // The MCP endpoint: bearer auth, then a fresh stateless server per request bound to the caller's OSM token.
  const auth = requireBearerAuth({
    verifier: proxy,
    requiredScopes: ["mcp"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(proxy.resource)),
    expectedResource: new URL(proxy.resource),
  });
  // The server is rebuilt for every request, so the bulk-edit guard's counts live here, keyed by a hash of the caller's
  // OSM token. Reconnecting (a new OSM authorization) starts a new count: the guard is friction, not a security boundary.
  const guards = new TtlMap<WriteGuard>(cfg.http.tokenTtlSeconds * 1000, 5_000);
  const node = toNodeHandler(
    createMcpHandler((ctx) => {
      if (!ctx.authInfo) throw new Error("unauthenticated");
      const osmToken = proxy.session(ctx.authInfo.token)?.osmToken ?? ctx.authInfo.token;
      const key = createHash("sha256").update(osmToken).digest("hex");
      let guard = guards.get(key);
      if (!guard) guards.set(key, (guard = new WriteGuard(cfg)));
      return createServer(cfg, new RequestAuth(proxy, ctx.authInfo.token), skills, guard);
    }),
  );
  app.all("/mcp", auth, (req, res) => void node(req, res, req.body));

  // Errors from the OAuth endpoints become JSON (or an HTML page for browser steps).
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof OAuthHttpError) {
      noStore(res);
      if (req.path === "/oauth/callback" || req.path === "/authorize/consent") return html(res, err.status, errorPage(err.description));
      return void res.status(err.status).json({ error: err.code, error_description: err.description });
    }
    console.error(`unhandled error: ${(err as Error)?.message ?? err}`);
    res.status(500).json({ error: "server_error" });
  });
  return { app, proxy };
}

export function startHttpServer(cfg: Config, skills?: SkillsCatalog): Promise<Server> {
  const { app } = createHttpApp(cfg, undefined, skills);
  return new Promise((resolve, reject) => {
    const server = app.listen(cfg.http.port, cfg.http.host, () => resolve(server));
    server.once("error", reject);
  });
}
