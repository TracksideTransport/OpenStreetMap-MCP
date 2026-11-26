import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";
import { b64url, buildAuthorizeUrl, exchangeOsmCode, makePkce, revokeOsmToken } from "../auth.js";
import type { Config } from "../config.js";
import { TtlMap } from "./store.js";

/** Error that maps to an OAuth JSON error response. */
export class OAuthHttpError extends Error {
  constructor(public status: number, public code: string, public description: string) {
    super(`${code}: ${description}`);
  }
}

export interface RegisteredClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

interface Txn {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  osmVerifier: string;
  /** Set once the user approved on our consent page; the callback is refused before that. */
  consented: boolean;
}
interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  osmToken: string;
  osmScope?: string;
}
export interface Session {
  osmToken: string;
  osmScope?: string;
  clientId: string;
  expiresAt: number; // epoch ms
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const BAD_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "ws:", "wss:", "ftp:"]);
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");
const rand = (bytes = 32) => b64url(randomBytes(bytes));

/** https, loopback http (RFC 8252), or a private-use custom scheme of a native app; never a fragment or credentials. */
export function isAllowedRedirectUri(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return !BAD_SCHEMES.has(url.protocol);
}

export function redirectWith(base: string, params: Record<string, string | undefined>): string {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export type AuthorizeResult =
  | { kind: "page-error"; message: string }
  | { kind: "redirect"; url: string }
  | { kind: "consent"; txnId: string; clientName: string; redirectOrigin: string; scopes: string[] };

/**
 * A small OAuth 2.1 authorization server (RFC 8414 metadata, RFC 7591 registration, PKCE S256, no client secrets)
 * that delegates user login to OpenStreetMap. OSM itself cannot act as an MCP authorization server (no dynamic client
 * registration, tokens are not audience-bound), so this server issues its own opaque, expiring access tokens and keeps
 * the OSM token server-side. All state is in memory: a restart signs everyone out.
 */
export class OAuthProxy {
  private clients: TtlMap<RegisteredClient>;
  private txns: TtlMap<Txn>;
  private codes: TtlMap<AuthCode>;
  private sessions: TtlMap<Session>;

  constructor(private cfg: Config, private now: () => number = Date.now) {
    this.clients = new TtlMap(30 * 86_400_000, 500, now);
    this.txns = new TtlMap(10 * 60_000, 2_000, now);
    this.codes = new TtlMap(5 * 60_000, 2_000, now);
    this.sessions = new TtlMap(cfg.http.tokenTtlSeconds * 1000, 10_000, now);
  }

  get issuer() {
    return this.cfg.http.publicUrl;
  }
  get resource() {
    return `${this.cfg.http.publicUrl}/mcp`;
  }
  get callbackUrl() {
    return `${this.cfg.http.publicUrl}/oauth/callback`;
  }

  metadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      registration_endpoint: `${this.issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    };
  }

  // ---- RFC 7591 dynamic client registration ----
  registerClient(body: unknown) {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const uris = b.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every(isAllowedRedirectUri)) {
      throw new OAuthHttpError(400, "invalid_redirect_uri", "redirect_uris must be 1-10 URIs: https, loopback http, or a custom app scheme (no fragments or credentials).");
    }
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none") {
      throw new OAuthHttpError(400, "invalid_client_metadata", "Only token_endpoint_auth_method 'none' (public clients with PKCE) is supported.");
    }
    const name = typeof b.client_name === "string" ? b.client_name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 100) : undefined;
    const client: RegisteredClient = { client_id: rand(16), client_name: name || undefined, redirect_uris: [...uris] };
    this.clients.set(client.client_id, client);
    return {
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(this.now() / 1000),
    };
  }

  // ---- /authorize ----
  beginAuthorize(q: URLSearchParams): AuthorizeResult {
    const client = this.clients.get(q.get("client_id") ?? "");
    const redirectUri = q.get("redirect_uri") ?? "";
    // Never redirect to an unvalidated URI: show an error page instead.
    if (!client) return { kind: "page-error", message: "Unknown client_id. Register the client first." };
    if (!client.redirect_uris.includes(redirectUri)) return { kind: "page-error", message: "redirect_uri does not match any URI registered for this client." };

    const state = q.get("state") ?? undefined;
    const err = (error: string, description: string): AuthorizeResult => ({ kind: "redirect", url: redirectWith(redirectUri, { error, error_description: description, state }) });
    if (q.get("response_type") !== "code") return err("unsupported_response_type", "response_type must be 'code'.");
    const challenge = q.get("code_challenge") ?? "";
    if (q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return err("invalid_request", "PKCE with code_challenge_method=S256 is required.");
    const resource = q.get("resource");
    if (resource && resource !== this.resource) return err("invalid_target", `resource must be ${this.resource}`);

    const { verifier } = makePkce();
    const txnId = rand(24);
    this.txns.set(txnId, { clientId: client.client_id, redirectUri, state, codeChallenge: challenge, osmVerifier: verifier, consented: false });
    let origin: string;
    try {
      const u = new URL(redirectUri);
      origin = u.protocol.startsWith("http") ? u.origin : `${u.protocol}//`;
    } catch {
      origin = "(unknown)";
    }
    return { kind: "consent", txnId, clientName: client.client_name ?? "An unnamed application", redirectOrigin: origin, scopes: this.cfg.scopes };
  }

  /** The user answered the consent page. `cookieTxn` must equal `txnId` (CSRF / session binding). */
  consent(txnId: string, cookieTxn: string | undefined, approve: boolean): string {
    if (!cookieTxn || !safeEqual(cookieTxn, txnId)) throw new OAuthHttpError(403, "access_denied", "Missing or mismatched session cookie; start again from your MCP client.");
    const txn = this.txns.get(txnId);
    if (!txn) throw new OAuthHttpError(400, "invalid_request", "This authorization request expired; start again from your MCP client.");
    if (!approve) {
      this.txns.delete(txnId);
      return redirectWith(txn.redirectUri, { error: "access_denied", error_description: "The user denied the request.", state: txn.state });
    }
    txn.consented = true;
    this.txns.set(txnId, txn, 10 * 60_000);
    return buildAuthorizeUrl(this.cfg, txnId, makeChallenge(txn.osmVerifier), this.callbackUrl);
  }

  // ---- OSM redirects the browser back here ----
  async complete(params: URLSearchParams, cookieTxn: string | undefined): Promise<string> {
    const state = params.get("state") ?? "";
    if (!cookieTxn || !safeEqual(cookieTxn, state)) throw new OAuthHttpError(400, "invalid_request", "State or session cookie mismatch; start again from your MCP client.");
    const txn = this.txns.take(state);
    if (!txn || !txn.consented) throw new OAuthHttpError(400, "invalid_request", "Unknown or expired authorization request.");
    const fail = (error: string, description: string) => redirectWith(txn.redirectUri, { error, error_description: description, state: txn.state });

    const osmError = params.get("error");
    const osmCode = params.get("code");
    if (osmError || !osmCode) return fail(osmError === "access_denied" ? "access_denied" : "server_error", `OpenStreetMap login failed: ${osmError ?? "no code returned"}`);
    let tok;
    try {
      tok = await exchangeOsmCode(this.cfg, osmCode, txn.osmVerifier, this.callbackUrl);
    } catch (e) {
      console.error(`osm token exchange failed: ${(e as Error).message}`);
      return fail("server_error", "Could not exchange the OpenStreetMap authorization code.");
    }
    const code = rand(32);
    this.codes.set(code, { clientId: txn.clientId, redirectUri: txn.redirectUri, codeChallenge: txn.codeChallenge, osmToken: tok.access_token, osmScope: tok.scope });
    return redirectWith(txn.redirectUri, { code, state: txn.state });
  }

  // ---- /token ----
  token(params: URLSearchParams) {
    if (params.get("grant_type") !== "authorization_code") throw new OAuthHttpError(400, "unsupported_grant_type", "Only authorization_code is supported.");
    const code = params.get("code") ?? "";
    const entry = this.codes.take(code); // single use, even if the checks below fail
    if (!entry) throw new OAuthHttpError(400, "invalid_grant", "Unknown, expired, or already used authorization code.");
    if (params.get("client_id") !== entry.clientId || params.get("redirect_uri") !== entry.redirectUri) throw new OAuthHttpError(400, "invalid_grant", "client_id or redirect_uri does not match the authorization request.");
    const verifier = params.get("code_verifier") ?? "";
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(makeChallenge(verifier), entry.codeChallenge)) throw new OAuthHttpError(400, "invalid_grant", "PKCE verification failed.");
    const resource = params.get("resource");
    if (resource && resource !== this.resource) throw new OAuthHttpError(400, "invalid_target", `resource must be ${this.resource}`);

    const access = rand(32);
    const ttlMs = this.cfg.http.tokenTtlSeconds * 1000;
    this.sessions.set(sha256hex(access), { osmToken: entry.osmToken, osmScope: entry.osmScope, clientId: entry.clientId, expiresAt: this.now() + ttlMs });
    return { access_token: access, token_type: "Bearer", expires_in: this.cfg.http.tokenTtlSeconds, scope: "mcp" };
  }

  // ---- resource-server side ----
  session(accessToken: string): Session | undefined {
    return this.sessions.get(sha256hex(accessToken));
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const s = this.session(token);
    if (!s) throw new OAuthError(OAuthErrorCode.InvalidToken, "Unknown or expired access token");
    return { token, clientId: s.clientId, scopes: ["mcp"], expiresAt: Math.floor(s.expiresAt / 1000), resource: new URL(this.resource) };
  }

  /** Sign out: forget the session and revoke the OSM token. */
  async revoke(accessToken: string): Promise<void> {
    const key = sha256hex(accessToken);
    const s = this.sessions.take(key);
    if (s) await revokeOsmToken(this.cfg, s.osmToken);
  }
}

function makeChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier).digest());
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
