import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "./config.js";

interface StoredToken {
  access_token: string;
  scope?: string;
  created_at?: number;
}

export const b64url = (buf: Buffer) => buf.toString("base64url");

export function makePkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function redirectUri(cfg: Config) {
  return `http://127.0.0.1:${cfg.redirectPort}/callback`;
}

export function buildAuthorizeUrl(cfg: Config, state: string, challenge: string, redirect: string = redirectUri(cfg)) {
  const u = new URL(`${cfg.webBase}/oauth2/authorize`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", cfg.clientId ?? "");
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export interface OsmTokenResponse {
  access_token: string;
  scope?: string;
  created_at?: number;
}

/** Exchange an OSM authorization code (PKCE) for an access token. */
export async function exchangeOsmCode(cfg: Config, code: string, verifier: string, redirect: string): Promise<OsmTokenResponse> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: cfg.clientId ?? "", code_verifier: verifier });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  const r = await fetch(`${cfg.webBase}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": cfg.userAgent },
    body,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as OsmTokenResponse;
  if (!j.access_token) throw new Error("OSM token response had no access_token");
  return { access_token: j.access_token, scope: j.scope, created_at: j.created_at };
}

/** Revoke an OSM token (best effort). */
export async function revokeOsmToken(cfg: Config, token: string): Promise<void> {
  if (!cfg.clientId) return;
  const body = new URLSearchParams({ token, client_id: cfg.clientId });
  if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
  await fetch(`${cfg.webBase}/oauth2/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": cfg.userAgent },
    body,
  }).catch(() => {});
}

/** What the tools need from authentication; implemented by the stdio `Auth` and the per-request HTTP auth. */
export interface AuthLike {
  getToken(): Promise<string | undefined>;
  requireToken(): Promise<string>;
  scopes(): string | undefined;
  logout(): Promise<void>;
  /** Interactive loopback login; only available over stdio. */
  startLogin?(timeoutMs?: number): Promise<{ url: string; done: Promise<{ scope?: string }> }>;
}

/** Holds the OAuth 2.0 access token (OSM tokens do not expire until revoked). */
export class Auth implements AuthLike {
  private token: StoredToken | undefined;
  private loaded = false;

  constructor(private cfg: Config) {}

  async getToken(): Promise<string | undefined> {
    if (this.cfg.staticToken) return this.cfg.staticToken;
    if (!this.loaded) {
      this.loaded = true;
      try {
        this.token = JSON.parse(await readFile(this.cfg.tokenFile, "utf8")) as StoredToken;
      } catch {
        this.token = undefined;
      }
    }
    return this.token?.access_token;
  }

  async requireToken(): Promise<string> {
    const t = await this.getToken();
    if (!t) throw new Error("Not authenticated. Run the osm_login tool first (or set OSM_ACCESS_TOKEN).");
    return t;
  }

  scopes(): string | undefined {
    return this.token?.scope;
  }

  private async save(t: StoredToken) {
    this.token = t;
    this.loaded = true;
    await mkdir(dirname(this.cfg.tokenFile), { recursive: true, mode: 0o700 });
    await writeFile(this.cfg.tokenFile, JSON.stringify(t), { mode: 0o600 });
    await chmod(this.cfg.tokenFile, 0o600);
  }

  /**
   * Authorization-code flow with PKCE using a loopback redirect.
   * Returns the URL to open immediately; `done` resolves once the user approves.
   */
  async startLogin(timeoutMs = 5 * 60_000): Promise<{ url: string; done: Promise<StoredToken> }> {
    if (!this.cfg.clientId) {
      throw new Error("OSM_CLIENT_ID is not set. Register an OAuth 2 application at https://www.openstreetmap.org/oauth2/applications and set its client ID.");
    }
    const { verifier, challenge } = makePkce();
    const state = b64url(randomBytes(16));
    const url = buildAuthorizeUrl(this.cfg, state, challenge);

    let settle!: { resolve: (t: StoredToken) => void; reject: (e: Error) => void };
    const done = new Promise<StoredToken>((resolve, reject) => (settle = { resolve, reject }));
    // Avoid unhandled-rejection noise if the caller never awaits `done`.
    done.catch(() => {});

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${this.cfg.redirectPort}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const reply = (status: number, msg: string) => {
        res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(msg);
      };
      if (u.searchParams.get("state") !== state) return reply(400, "State mismatch.");
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (err || !code) {
        reply(400, `Authorization failed: ${err ?? "no code"}`);
        finish(new Error(`Authorization failed: ${err ?? "no code returned"}`));
        return;
      }
      this.exchangeCode(code, verifier).then(
        (tok) => {
          reply(200, "OpenStreetMap MCP is now authorized. You can close this tab.");
          finish(undefined, tok);
        },
        (e: Error) => {
          reply(500, `Token exchange failed: ${e.message}`);
          finish(e);
        },
      );
    });

    const timer = setTimeout(() => finish(new Error("Login timed out.")), timeoutMs);
    const finish = (e?: Error, tok?: StoredToken) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections?.();
      if (e) settle.reject(e);
      else settle.resolve(tok!);
    };

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.cfg.redirectPort, "127.0.0.1", () => resolve());
    });
    return { url, done };
  }

  private async exchangeCode(code: string, verifier: string): Promise<StoredToken> {
    const j = await exchangeOsmCode(this.cfg, code, verifier, redirectUri(this.cfg));
    const tok: StoredToken = { access_token: j.access_token, scope: j.scope, created_at: j.created_at };
    await this.save(tok);
    return tok;
  }

  async logout(): Promise<void> {
    const t = this.token?.access_token;
    if (t) await revokeOsmToken(this.cfg, t);
    this.token = undefined;
    this.loaded = true;
    await rm(this.cfg.tokenFile, { force: true });
  }
}
