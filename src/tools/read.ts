import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { filterAndPage, type MapElement } from "../bbox.js";
import { SERVER_NAME, VERSION } from "../version.js";
import { READ_ONLY, safe, type Ctx } from "./util.js";

const type = z.enum(["node", "way", "relation"]);

export function registerReadTools(server: McpServer, { osm, cfg }: Ctx) {
  server.registerTool(
    "osm_capabilities",
    { description: "Get API capabilities and limits of the connected OSM server (max bbox area, changeset size, timeouts), plus which openstreetmap-mcp version and OSM server this is (mcp.version).", inputSchema: z.object({}), annotations: READ_ONLY },
    safe(async () => ({ mcp: { name: SERVER_NAME, version: VERSION, environment: cfg.env, api: cfg.apiBase }, ...(await osm.getJson("/capabilities.json")) })),
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
      description:
        "Download the OSM data in a bounding box, filtered and paged so the result is always complete valid JSON. " +
        "The API limits the area (see osm_capabilities, default 0.25 square degrees) and returns every node of every way that touches the box, so even a tiny box in a dense city can hold thousands of elements. " +
        "Use tag_filters (for example [\"railway=subway_entrance\", \"highway=elevator\"]), types, tagged_only, inside_bbox_only and compact to get just what you need, and page with next_offset when it is not null. " +
        "Unfiltered results are sorted as the API sends them (by type, then id), so tagged features can sit on later pages.",
      inputSchema: z.object({
        min_lon: z.number().min(-180).max(180),
        min_lat: z.number().min(-90).max(90),
        max_lon: z.number().min(-180).max(180),
        max_lat: z.number().min(-90).max(90),
        types: z.array(z.enum(["node", "way", "relation"])).max(3).optional().describe("Keep only these element types"),
        tag_filters: z.array(z.string().min(1).max(300)).max(20).optional().describe('Keep elements with ANY of these tags: "key" (any value) or "key=value"'),
        tagged_only: z.boolean().default(false).describe("Skip elements without tags (for example the untagged nodes of ways)"),
        inside_bbox_only: z.boolean().default(false).describe("Drop nodes outside the box; the API also returns far-away nodes of ways that merely touch it. Ways keep their full node id lists."),
        compact: z.boolean().default(false).describe("Return only type, id, lat, lon, tags, nodes and members (drops version, timestamp, changeset, uid, user)"),
        limit: z.number().int().min(1).max(2000).default(200).describe("Maximum elements per page; a page may be shorter to stay within the size cap"),
        offset: z.number().int().min(0).default(0).describe("Start at this element of the filtered list (use the previous next_offset)"),
      }),
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      const box = { min_lon: a.min_lon, min_lat: a.min_lat, max_lon: a.max_lon, max_lat: a.max_lat };
      const json = await osm.getJson("/map.json", { query: { bbox: `${box.min_lon},${box.min_lat},${box.max_lon},${box.max_lat}` }, auth: "optional" });
      const all: MapElement[] = json.elements ?? [];
      const page = filterAndPage(all, { types: a.types, tagFilters: a.tag_filters, taggedOnly: a.tagged_only, insideOnly: a.inside_bbox_only ? box : undefined, compact: a.compact, offset: a.offset, limit: a.limit });
      return { bbox: box, total_in_area: all.length, ...page };
    }),
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
