import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAuthorizeUrl, makePkce, redirectUri } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

describe("pkce", () => {
  it("challenge is base64url(sha256(verifier))", () => {
    const { verifier, challenge } = makePkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toMatch(/[+/=]/);
  });
});

describe("authorize url", () => {
  it("includes PKCE, scopes and loopback redirect", () => {
    const cfg = loadConfig({ OSM_CLIENT_ID: "abc", OSM_SCOPES: "read_prefs write_api", OSM_REDIRECT_PORT: "9000" });
    const u = new URL(buildAuthorizeUrl(cfg, "st", "chal"));
    expect(u.origin + u.pathname).toBe("https://www.openstreetmap.org/oauth2/authorize");
    expect(u.searchParams.get("client_id")).toBe("abc");
    expect(u.searchParams.get("scope")).toBe("read_prefs write_api");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9000/callback");
    expect(redirectUri(cfg)).toBe("http://127.0.0.1:9000/callback");
  });

  it("dev env points at the sandbox", () => {
    const cfg = loadConfig({ OSM_ENV: "dev" });
    expect(cfg.apiBase).toBe("https://master.apis.dev.openstreetmap.org");
    expect(cfg.webBase).toBe("https://master.apis.dev.openstreetmap.org");
    expect(cfg.tokenFile).toContain("tokens-dev.json");
  });
});
