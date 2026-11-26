import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { SERVER_NAME, VERSION } from "../version.js";
import { READ_ONLY, WRITE, safe, type Ctx } from "./util.js";

export function registerAuthTools(server: McpServer, { auth, osm, cfg }: Ctx) {
  // Interactive loopback login exists only over stdio; over HTTP the MCP OAuth flow signs the user in.
  if (auth.startLogin) {
    let pending: Promise<unknown> | undefined;

    server.registerTool(
      "osm_login",
      {
        description:
          "Start OAuth 2.0 login (authorization code + PKCE). Returns a URL the user must open in a browser and approve; the token is then captured automatically by a temporary local listener (5 minute window). Afterwards call osm_whoami to confirm. Needed before any editing or note-writing tool.",
        inputSchema: z.object({}),
        annotations: WRITE,
      },
      safe(async () => {
        if (pending) throw new Error("A login is already in progress. Finish it in the browser, or wait for it to time out.");
        if (!auth.startLogin) throw new Error("Interactive login is not available in this mode.");
        const { url, done } = await auth.startLogin();
        pending = done.then(() => undefined, () => undefined).finally(() => (pending = undefined));
        return {
          authorize_url: url,
          next: "Ask the user to open authorize_url and approve access, then call osm_whoami to confirm.",
          scopes: cfg.scopes,
        };
      }),
    );
  }

  server.registerTool(
    "osm_logout",
    { description: "Revoke the stored OAuth token and delete it from disk.", inputSchema: z.object({}), annotations: WRITE },
    safe(async () => {
      await auth.logout();
      return "Logged out.";
    }),
  );

  server.registerTool(
    "osm_whoami",
    {
      description: "Show the server being used and the authenticated user (if any), including permissions.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    safe(async () => {
      const base = { server: { name: SERVER_NAME, version: VERSION }, environment: cfg.env, api: cfg.apiBase };
      if (!(await auth.getToken())) return { ...base, authenticated: false };
      const details = await osm.getJson("/user/details.json", { auth: "required" });
      let permissions: unknown;
      try {
        permissions = (await osm.getJson("/permissions.json", { auth: "required" })).permissions;
      } catch {
        /* ignore */
      }
      return { ...base, authenticated: true, user: details.user, permissions };
    }),
  );
}
