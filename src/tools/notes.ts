import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { NOT_CONFIRMED, reviewPublicText } from "../confirm.js";
import { READ_ONLY, WRITE, safe, type Ctx } from "./util.js";

const noteId = z.number().int().positive();
const text = z.string().min(1).max(10_000);

export function registerNoteTools(server: McpServer, { osm, cfg }: Ctx) {
  server.registerTool(
    "osm_get_notes_in_bbox",
    {
      description: "List map notes (user-reported map problems) in a bounding box. Max bbox area is limited by the server.",
      inputSchema: z.object({
        min_lon: z.number(), min_lat: z.number(), max_lon: z.number(), max_lat: z.number(),
        limit: z.number().int().min(1).max(10000).default(100),
        closed: z.number().int().default(7).describe("Days a closed note stays visible; 0 = only open, -1 = all"),
      }),
      annotations: READ_ONLY,
    },
    safe(async (a) =>
      osm.getJson("/notes.json", { query: { bbox: `${a.min_lon},${a.min_lat},${a.max_lon},${a.max_lat}`, limit: a.limit, closed: a.closed }, auth: "optional" })),
  );

  server.registerTool(
    "osm_search_notes",
    {
      description: "Full-text search of map notes and their comments.",
      inputSchema: z.object({
        q: z.string().min(1),
        limit: z.number().int().min(1).max(10000).default(100),
        closed: z.number().int().default(7),
        sort: z.enum(["created_at", "updated_at"]).default("updated_at"),
        order: z.enum(["newest", "oldest"]).default("newest"),
      }),
      annotations: READ_ONLY,
    },
    safe(async (a) => osm.getJson("/notes/search.json", { query: a, auth: "optional" })),
  );

  server.registerTool(
    "osm_get_note",
    { description: "Read one map note with its full comment thread.", inputSchema: z.object({ id: noteId }), annotations: READ_ONLY },
    safe(async ({ id }) => osm.getJson(`/notes/${id}.json`, { auth: "optional" })),
  );

  server.registerTool(
    "osm_create_note",
    {
      description: "Create a map note at a location. Requires auth with the write_notes scope. Public and visible to everyone, under the user's name: the user is shown the text and can change it before it is sent, so write plain facts (what, where, why) and do not compose long prose for them.",
      inputSchema: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), text }),
      annotations: WRITE,
    },
    safe(async (a, ctx) => {
      const final = await reviewPublicText(ctx, cfg, `Create a map note at ${a.lat}, ${a.lon}`, a.text, { required: true });
      if (final === null || final === undefined) return NOT_CONFIRMED;
      return JSON.parse(await osm.send("POST", "/notes.json", { query: { lat: a.lat, lon: a.lon, text: final } }));
    }),
  );

  for (const [name, action, desc] of [
    ["osm_comment_note", "comment", "Add a comment to an open map note."],
    ["osm_close_note", "close", "Close a map note (optionally with a closing comment)."],
    ["osm_reopen_note", "reopen", "Reopen a closed map note (optionally with a comment)."],
  ] as const) {
    server.registerTool(
      name,
      {
        description: `${desc} Requires auth with the write_notes scope.`,
        inputSchema: z.object({ id: noteId, text: action === "comment" ? text : text.optional() }),
        annotations: WRITE,
      },
      safe(async ({ id, text }, ctx) => {
        const final = await reviewPublicText(ctx, cfg, `${action === "comment" ? "Comment on" : action === "close" ? "Close" : "Reopen"} map note ${id}`, text, { required: action === "comment" });
        if (final === null) return NOT_CONFIRMED;
        return JSON.parse(await osm.send("POST", `/notes/${id}/${action}.json`, { query: { text: final } }));
      }),
    );
  }
}
