import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { DESTRUCTIVE, READ_ONLY, WRITE, safe, type Ctx } from "./util.js";

// A key made only of dots ("." or "..") would be collapsed by URL dot-segment normalization
// (/user/preferences/.. -> /user/) and redirect the request to a different endpoint, so refuse it.
const key = z
  .string()
  .min(1)
  .max(255)
  .refine((k) => !/^\.+$/.test(k), { message: "Key must not consist only of dots" });
const READ = "Needs the read_prefs OAuth scope.";
const WRITE_SCOPE = "Needs the write_prefs OAuth scope (add it to OSM_SCOPES and the OSM app registration).";

export function registerPreferenceTools(server: McpServer, { osm }: Ctx) {
  server.registerTool(
    "osm_get_preferences",
    {
      description: `Read the authenticated user's OSM preferences: all of them, or one by key. These are free-form key/value strings that editors store per account. ${READ}`,
      inputSchema: z.object({ key: key.optional() }),
      annotations: READ_ONLY,
    },
    safe(async ({ key }) => {
      if (key !== undefined) {
        const value = await osm.getText(`/user/preferences/${encodeURIComponent(key)}`, { auth: "required" });
        return { key, value };
      }
      return osm.getJson("/user/preferences.json", { auth: "required" });
    }),
  );

  server.registerTool(
    "osm_set_preference",
    {
      description: `Set one preference (value is a string up to 255 chars; a user may have at most 150). ${WRITE_SCOPE}`,
      inputSchema: z.object({ key, value: z.string().max(255) }),
      annotations: WRITE,
    },
    safe(async ({ key, value }) => {
      await osm.send("PUT", `/user/preferences/${encodeURIComponent(key)}`, { body: value, contentType: "text/plain" });
      return { key, value };
    }),
  );

  server.registerTool(
    "osm_delete_preference",
    { description: `Delete one preference by key. ${WRITE_SCOPE}`, inputSchema: z.object({ key }), annotations: DESTRUCTIVE },
    safe(async ({ key }) => {
      await osm.send("DELETE", `/user/preferences/${encodeURIComponent(key)}`);
      return { deleted: key };
    }),
  );
}
