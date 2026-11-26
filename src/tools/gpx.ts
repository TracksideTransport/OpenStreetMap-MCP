import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { summarizeGpx } from "../gpx.js";
import { DESTRUCTIVE, READ_ONLY, WRITE, safe, type Ctx } from "./util.js";

const id = z.number().int().positive();
// The API only accepts these two for new or changed traces ("private"/"public" are legacy values that
// can no longer be set), and both publish the points. There is no safe default, so callers must choose.
const visibility = z.enum(["trackable", "identifiable"]);
const VIS_HELP = "'trackable' shares the points anonymously (ordered, with timestamps); 'identifiable' also lists the trace publicly under the user's name.";
const PRIVACY = `Every visibility OSM accepts publishes the track points, and GPS traces can reveal where someone lives, works and travels: ask the user which one they want (${VIS_HELP}) and never pick for them.`;
const SCOPE = "Needs the read_gpx / write_gpx OAuth scope (add it to OSM_SCOPES and the OSM app registration).";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The JSON details response is {trace:{...}} (list: {traces:[...]}); older docs show gpx_file(s), so accept those too. */
export function pickGpxFile(j: any): any {
  return j?.trace ?? j?.traces?.[0] ?? j?.gpx_file ?? j?.gpx_files?.[0] ?? j;
}

/** The update body must carry the trace id ("ID is required when updating"). */
export function buildGpxMetadataXml(f: { id: number; name?: string; visibility: string; description: string; tags: string[] }): string {
  const tags = f.tags.map((t) => `<tag>${esc(t)}</tag>`).join("");
  return `<osm><gpx_file id="${f.id}"${f.name ? ` name="${esc(f.name)}"` : ""} visibility="${esc(f.visibility)}"><description>${esc(f.description)}</description>${tags}</gpx_file></osm>`;
}

export function registerGpxTools(server: McpServer, { osm }: Ctx) {
  server.registerTool(
    "osm_get_trackpoints",
    {
      description: `Public GPS track points inside a bounding box (max 0.25 degrees wide and high), 5,000 points per page, summarized per trace (name, description, point count, bbox, time range). Set include_points to also get coordinates (capped by max_points). Points of non-trackable traces are shuffled by the API. Page through with page=0,1,2… while has_more is true. Data © OpenStreetMap contributors.`,
      inputSchema: z.object({
        min_lon: z.number().min(-180).max(180),
        min_lat: z.number().min(-90).max(90),
        max_lon: z.number().min(-180).max(180),
        max_lat: z.number().min(-90).max(90),
        page: z.number().int().min(0).default(0),
        include_points: z.boolean().default(false),
        max_points: z.number().int().min(1).max(5000).default(200),
      }),
      annotations: READ_ONLY,
    },
    safe(async (a) => {
      if (a.max_lon - a.min_lon > 0.25 || a.max_lat - a.min_lat > 0.25) throw new Error("Bounding box too large: width and height must each be at most 0.25 degrees.");
      const xml = await osm.getText("/trackpoints", { query: { bbox: `${a.min_lon},${a.min_lat},${a.max_lon},${a.max_lat}`, page: a.page }, auth: "optional" });
      const sum = summarizeGpx(xml, { includePoints: a.include_points, maxPoints: a.max_points });
      return { page: a.page, has_more: sum.total_points >= 5000, ...sum };
    }),
  );

  server.registerTool(
    "osm_list_my_gpx_files",
    { description: `List the authenticated user's own GPS traces (metadata only). ${SCOPE}`, inputSchema: z.object({}), annotations: READ_ONLY },
    safe(async () => osm.getJson("/user/gpx_files.json", { auth: "required" })),
  );

  server.registerTool(
    "osm_get_gpx_details",
    {
      description: "Metadata of one GPS trace (name, description, tags, visibility, owner, timestamp). Public traces need no login; private ones only work for their owner.",
      inputSchema: z.object({ id }),
      annotations: READ_ONLY,
    },
    safe(async ({ id }) => osm.getJson(`/gpx/${id}.json`, { auth: "optional" })),
  );

  server.registerTool(
    "osm_get_gpx_data",
    {
      description: "Download a GPS trace's points. Default 'summary' returns a compact JSON summary (point count, bbox, time range; optionally some points). Use format 'gpx' for the raw GPX text (truncated if very large). Public traces need no login; private ones only work for their owner.",
      inputSchema: z.object({
        id,
        format: z.enum(["summary", "gpx"]).default("summary"),
        include_points: z.boolean().default(false),
        max_points: z.number().int().min(1).max(5000).default(200),
      }),
      annotations: READ_ONLY,
    },
    safe(async ({ id, format, include_points, max_points }) => {
      const xml = await osm.getText(`/gpx/${id}/data.gpx`, { auth: "optional" });
      return format === "gpx" ? xml : summarizeGpx(xml, { includePoints: include_points, maxPoints: max_points });
    }),
  );

  server.registerTool(
    "osm_upload_gpx",
    {
      description: `Upload a GPX file (pass its XML text). The file must contain <trkpt> points with timestamps. visibility is required. ${PRIVACY} ${SCOPE} Uploads are processed asynchronously by OSM.`,
      inputSchema: z.object({
        gpx: z.string().min(20).max(25_000_000).describe("GPX XML content"),
        filename: z.string().min(1).max(100).default("track.gpx"),
        description: z.string().min(1).max(255),
        tags: z.array(z.string().min(1).max(50)).max(20).default([]),
        visibility: visibility.describe(VIS_HELP),
      }),
      annotations: WRITE,
    },
    safe(async (a) => {
      const form = new FormData();
      form.set("file", new Blob([a.gpx], { type: "application/gpx+xml" }), a.filename);
      form.set("description", a.description);
      form.set("tags", a.tags.join(","));
      form.set("visibility", a.visibility);
      const out = await osm.send("POST", "/gpx", { body: form });
      return { gpx_id: Number(out.trim()), visibility: a.visibility, note: "Queued for processing; points appear shortly." };
    }),
  );

  server.registerTool(
    "osm_update_gpx",
    {
      description: `Change a GPS trace's description, tags, or visibility (owner only). Omitted fields keep their current values. OSM cannot change a trace back to the legacy 'private' or 'public' values. ${PRIVACY} ${SCOPE}`,
      inputSchema: z.object({ id, description: z.string().min(1).max(255).optional(), tags: z.array(z.string().min(1).max(50)).max(20).optional(), visibility: visibility.optional() }),
      annotations: WRITE,
    },
    safe(async (a) => {
      if (a.description === undefined && a.tags === undefined && a.visibility === undefined) throw new Error("Nothing to do: provide description, tags, and/or visibility.");
      const cur = pickGpxFile(await osm.getJson(`/gpx/${a.id}.json`, { auth: "required" }));
      const next = {
        id: a.id,
        name: cur.name as string | undefined,
        visibility: a.visibility ?? (cur.visibility as string),
        description: a.description ?? String(cur.description ?? ""),
        tags: a.tags ?? asArray<string>(cur.tags ?? cur.tag),
      };
      if (!next.description) throw new Error("The trace has no description; provide one (it cannot be empty).");
      await osm.send("PUT", `/gpx/${a.id}`, { body: buildGpxMetadataXml(next) });
      return next;
    }),
  );

  server.registerTool(
    "osm_delete_gpx",
    { description: `Permanently delete one of your GPS traces. ${SCOPE}`, inputSchema: z.object({ id }), annotations: DESTRUCTIVE },
    safe(async ({ id }) => {
      await osm.send("DELETE", `/gpx/${id}`);
      return { deleted: id };
    }),
  );
}
