import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { READ_ONLY, safe, type Ctx } from "./util.js";

const type = z.enum(["node", "way", "relation"]);

export function registerReadTools(server: McpServer, { osm }: Ctx) {
  server.registerTool(
    "osm_capabilities",
    { description: "Get API capabilities and limits of the connected OSM server (max bbox area, changeset size, timeouts).", inputSchema: z.object({}), annotations: READ_ONLY },
    safe(async () => osm.getJson("/capabilities.json")),
  );

  server.registerTool(
    "osm_get_element",
    {
      description: "Read a single node, way, or relation (current version, or a specific version).",
      inputSchema: z.object({ type, id: z.number().int().positive(), version: z.number().int().positive().optional() }),
      annotations: READ_ONLY,
    },
    safe(async ({ type, id, version }) => osm.getJson(`/${type}/${id}${version ? `/${version}` : ""}.json`, { auth: "optional" })),
  );

  server.registerTool(
    "osm_get_elements",
    {
      description: "Read several elements of one type in a single call (current versions).",
      inputSchema: z.object({ type, ids: z.array(z.number().int().positive()).min(1).max(725) }),
      annotations: READ_ONLY,
    },
    safe(async ({ type, ids }) => osm.getJson(`/${type}s.json`, { query: { [`${type}s`]: ids.join(",") }, auth: "optional" })),
  );

  server.registerTool(
    "osm_get_element_full",
    {
      description: "Read a way or relation together with all the elements it references (nodes of a way; members of a relation).",
      inputSchema: z.object({ type: z.enum(["way", "relation"]), id: z.number().int().positive() }),
      annotations: READ_ONLY,
    },
    safe(async ({ type, id }) => osm.getJson(`/${type}/${id}/full.json`, { auth: "optional" })),
  );

  server.registerTool(
    "osm_element_history",
    {
      description: "List all versions of an element, oldest first. Useful to see who changed what.",
      inputSchema: z.object({ type, id: z.number().int().positive() }),
      annotations: READ_ONLY,
    },
    safe(async ({ type, id }) => osm.getJson(`/${type}/${id}/history.json`, { auth: "optional" })),
  );

  server.registerTool(
    "osm_element_parents",
    {
      description: "Find what uses an element: relations containing any element, or ways containing a node.",
      inputSchema: z.object({ type, id: z.number().int().positive(), parent: z.enum(["relations", "ways"]).default("relations").describe("'ways' is only valid for nodes") }),
      annotations: READ_ONLY,
    },
    safe(async ({ type, id, parent }) => {
      if (parent === "ways" && type !== "node") throw new Error("parent 'ways' is only valid for type 'node'");
      return osm.getJson(`/${type}/${id}/${parent}.json`, { auth: "optional" });
    }),
  );

  server.registerTool(
    "osm_get_bbox",
    {
      description: "Download all data in a bounding box. The API limits the area (see osm_capabilities, default 0.25 square degrees) and node count; keep boxes small.",
      inputSchema: z.object({
        min_lon: z.number().min(-180).max(180),
        min_lat: z.number().min(-90).max(90),
        max_lon: z.number().min(-180).max(180),
        max_lat: z.number().min(-90).max(90),
      }),
      annotations: READ_ONLY,
    },
    safe(async (b) => osm.getJson("/map.json", { query: { bbox: `${b.min_lon},${b.min_lat},${b.max_lon},${b.max_lat}` }, auth: "optional" })),
  );

  server.registerTool(
    "osm_get_changeset",
    {
      description: "Read a changeset's metadata, optionally with its discussion comments.",
      inputSchema: z.object({ id: z.number().int().positive(), include_discussion: z.boolean().default(false) }),
      annotations: READ_ONLY,
    },
    safe(async ({ id, include_discussion }) =>
      osm.getJson(`/changeset/${id}.json`, { query: { include_discussion: include_discussion ? "true" : undefined }, auth: "optional" })),
  );

  server.registerTool(
    "osm_get_changeset_diff",
    {
      description: "Get the osmChange (XML) describing everything a changeset created, modified, or deleted.",
      inputSchema: z.object({ id: z.number().int().positive() }),
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => osm.getText(`/changeset/${id}/download`, { auth: "optional" })),
  );

  server.registerTool(
    "osm_search_changesets",
    {
      description: "Search changesets. All filters are optional and combined with AND. Returns newest first, max 100.",
      inputSchema: z.object({
        user: z.string().optional().describe("Display name"),
        user_id: z.number().int().optional(),
        bbox: z.string().optional().describe("min_lon,min_lat,max_lon,max_lat"),
        time: z.string().optional().describe("ISO 8601; changesets closed after this time"),
        time_end: z.string().optional().describe("ISO 8601; with `time`, changesets created before this and closed after `time`"),
        open: z.boolean().optional(),
        closed: z.boolean().optional(),
        changesets: z.array(z.number().int()).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: READ_ONLY,
    },
    safe(async (a) =>
      osm.getJson("/changesets.json", {
        query: {
          display_name: a.user,
          user: a.user_id,
          bbox: a.bbox,
          time: a.time && a.time_end ? `${a.time},${a.time_end}` : a.time,
          open: a.open,
          closed: a.closed,
          changesets: a.changesets?.join(","),
          limit: a.limit,
        },
        auth: "optional",
      })),
  );

  server.registerTool(
    "osm_get_user",
    {
      description: "Get public profile details of a user by numeric id.",
      inputSchema: z.object({ id: z.number().int().positive() }),
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => osm.getJson(`/user/${id}.json`, { auth: "optional" })),
  );
}
