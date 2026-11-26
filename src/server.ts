import { McpServer } from "@modelcontextprotocol/server";
import { Auth } from "./auth.js";
import { loadConfig, type Config } from "./config.js";
import { OsmClient } from "./osm.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerEditTools } from "./tools/edit.js";
import { registerGeocodeTools } from "./tools/geocode.js";
import { registerNoteTools } from "./tools/notes.js";
import { registerReadTools } from "./tools/read.js";

export const VERSION = "0.1.1";

export function createServer(cfg: Config = loadConfig()) {
  const auth = new Auth(cfg);
  const osm = new OsmClient(cfg, auth);
  const ctx = { cfg, auth, osm };
  const server = new McpServer(
    { name: "openstreetmap-mcp", version: VERSION },
    {
      instructions:
        `Read and edit OpenStreetMap via API v0.6 (${cfg.env}: ${cfg.apiBase}). Reads work without login. ` +
        "Editing flow: osm_login -> osm_create_changeset -> osm_get_element (to get current version) -> osm_update_element / osm_create_element / osm_delete_element / osm_upload_diff -> osm_close_changeset. " +
        (cfg.enableGeocoding ? "osm_geocode / osm_reverse_geocode (Nominatim) turn place names into coordinates and bounding boxes; use them sparingly, one lookup per user request. " : "") +
        "Edits are public and permanent; confirm intent with the user before writing, and verify facts rather than guessing tags.",
    },
  );
  registerAuthTools(server, ctx);
  registerReadTools(server, ctx);
  registerEditTools(server, ctx);
  registerNoteTools(server, ctx);
  if (cfg.enableGeocoding) registerGeocodeTools(server, ctx);
  return server;
}
