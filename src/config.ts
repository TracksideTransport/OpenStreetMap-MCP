import { homedir } from "node:os";
import { join } from "node:path";

export type OsmEnv = "production" | "dev";

export interface Config {
  env: OsmEnv;
  /** Base of the REST API, e.g. https://api.openstreetmap.org */
  apiBase: string;
  /** Base of the website (hosts the OAuth 2.0 endpoints) */
  webBase: string;
  clientId: string | undefined;
  /** Only for confidential apps; public clients using PKCE leave this unset */
  clientSecret: string | undefined;
  /** Pre-obtained token; skips the interactive login flow */
  staticToken: string | undefined;
  redirectPort: number;
  scopes: string[];
  userAgent: string;
  tokenFile: string;
  /** Place-name search via Nominatim is opt-in; see the Nominatim usage policy. */
  enableGeocoding: boolean;
  nominatimBase: string;
  /** Ask the user (MCP elicitation) before risky or public writes. Default on; OSM_CONFIRM_WRITES=off disables. */
  confirmWrites: boolean;
  /** Streamable HTTP transport settings (only used with --http). */
  http: HttpConfig;
}

export interface HttpConfig {
  host: string;
  port: number;
  /** Externally visible base URL of this server: the OAuth issuer and the base of /mcp. No trailing slash. */
  publicUrl: string;
  /** Lifetime of access tokens this server issues, in seconds. */
  tokenTtlSeconds: number;
  /** Extra Host header values to accept (comma separated OSM_HTTP_ALLOWED_HOSTS); the public URL's host is always allowed. */
  allowedHosts: string[];
}

export const DEFAULT_SCOPES = ["read_prefs", "write_api", "write_changeset_comments", "write_notes"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const osmEnv: OsmEnv = env.OSM_ENV === "dev" ? "dev" : "production";
  const dev = osmEnv === "dev";
  const apiBase = (env.OSM_API_BASE ?? (dev ? "https://master.apis.dev.openstreetmap.org" : "https://api.openstreetmap.org")).replace(/\/+$/, "");
  const webBase = (env.OSM_WEB_BASE ?? (dev ? "https://master.apis.dev.openstreetmap.org" : "https://www.openstreetmap.org")).replace(/\/+$/, "");
  const configDir = env.OSM_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "openstreetmap-mcp");
  const httpHost = env.OSM_HTTP_HOST ?? "127.0.0.1";
  const httpPort = Number(env.OSM_HTTP_PORT ?? 3000);
  const publicUrl = (env.OSM_PUBLIC_URL ?? `http://${httpHost === "0.0.0.0" || httpHost === "::" ? "127.0.0.1" : httpHost}:${httpPort}`).replace(/\/+$/, "");
  return {
    env: osmEnv,
    apiBase,
    webBase,
    clientId: env.OSM_CLIENT_ID || undefined,
    clientSecret: env.OSM_CLIENT_SECRET || undefined,
    staticToken: env.OSM_ACCESS_TOKEN || undefined,
    redirectPort: Number(env.OSM_REDIRECT_PORT ?? 8787),
    scopes: env.OSM_SCOPES ? env.OSM_SCOPES.split(/[\s,]+/).filter(Boolean) : DEFAULT_SCOPES,
    userAgent: env.OSM_USER_AGENT ?? "openstreetmap-mcp/0.1 (+https://github.com/TracksideTransport/OpenStreetMap-MCP)",
    tokenFile: join(configDir, `tokens-${osmEnv}.json`),
    enableGeocoding: ["1", "true", "yes"].includes((env.OSM_ENABLE_GEOCODING ?? "").toLowerCase()),
    nominatimBase: (env.OSM_NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").replace(/\/+$/, ""),
    confirmWrites: !(["0", "false", "no", "off"].includes((env.OSM_CONFIRM_WRITES ?? "").toLowerCase())),
    http: {
      host: httpHost,
      port: httpPort,
      publicUrl,
      tokenTtlSeconds: Number(env.OSM_MCP_TOKEN_TTL ?? 86_400),
      allowedHosts: (env.OSM_HTTP_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean),
    },
  };
}
