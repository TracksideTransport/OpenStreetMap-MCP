import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { buildChangesetXml, buildElementXml, buildOsmChangeXml, parseDiffResult } from "../osm.js";
import { NOT_CONFIRMED, confirmWrite } from "../confirm.js";
import { patchTags } from "../patch.js";
import { DESTRUCTIVE, WRITE, safe, type Ctx } from "./util.js";

const id = z.number().int().positive();
const tags = z.record(z.string().max(255), z.string().max(255));
const element = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number().int().optional().describe("Existing id (modify/delete), or a negative placeholder for create in a diff"),
  version: z.number().int().positive().optional().describe("Current version; required for modify/delete"),
  lat: z.number().min(-90).max(90).optional().describe("Nodes only"),
  lon: z.number().min(-180).max(180).optional().describe("Nodes only"),
  nodes: z.array(z.number().int()).optional().describe("Ways only: ordered node ids"),
  members: z.array(z.object({ type: z.enum(["node", "way", "relation"]), ref: z.number().int(), role: z.string().optional() })).optional().describe("Relations only"),
  tags: tags.optional(),
});

const NOTE = "Edits are public and attributed to the authenticated OSM user. Follow the OSM editing guidelines; use OSM_ENV=dev to practise on the sandbox server.";

export function registerEditTools(server: McpServer, { osm, cfg, guard }: Ctx) {
  server.registerTool(
    "osm_create_changeset",
    {
      description: `Open a new changeset. All edits must belong to an open changeset; give it a meaningful comment. Returns the changeset id. ${NOTE}`,
      inputSchema: z.object({
        comment: z.string().min(1).max(255).describe("Human-readable summary of the edit"),
        source: z.string().max(255).optional().describe("Where the data came from, e.g. 'survey', 'Bing imagery'"),
        extra_tags: tags.optional(),
      }),
      annotations: WRITE,
    },
    safe(async ({ comment, source, extra_tags }, ctx) => {
      const t: Record<string, string> = { created_by: "openstreetmap-mcp", comment, ...(source ? { source } : {}), ...extra_tags };
      return guard.run(ctx, { changesets: 1, what: `open a new changeset ("${comment}")` }, async () => {
        const out = await osm.send("PUT", "/changeset/create", { body: buildChangesetXml(t) });
        return { changeset_id: Number(out.trim()), api: cfg.apiBase };
      });
    }),
  );

  server.registerTool(
    "osm_close_changeset",
    { description: "Close a changeset you own. Changesets also close automatically after an hour of inactivity.", inputSchema: z.object({ id }), annotations: WRITE },
    safe(async ({ id }) => {
      await osm.send("PUT", `/changeset/${id}/close`);
      return { closed: id };
    }),
  );

  server.registerTool(
    "osm_update_changeset_tags",
    {
      description: "Replace all tags on an open changeset you own (include existing ones you want to keep).",
      inputSchema: z.object({ id, tags }),
      annotations: WRITE,
    },
    safe(async ({ id, tags }) => {
      await osm.send("PUT", `/changeset/${id}`, { body: buildChangesetXml(tags) });
      return { updated: id };
    }),
  );

  server.registerTool(
    "osm_comment_changeset",
    {
      description: "Post a comment on a changeset's discussion (any changeset, not only yours). OSM only accepts comments on CLOSED changesets, and this needs the write_changeset_comments scope.",
      inputSchema: z.object({ id, text: z.string().min(1).max(2000) }),
      annotations: WRITE,
    },
    safe(async ({ id, text }) => {
      await osm.send("POST", `/changeset/${id}/comment`, { body: new URLSearchParams({ text }).toString(), contentType: "application/x-www-form-urlencoded" });
      return { commented: id };
    }),
  );

  server.registerTool(
    "osm_create_element",
    {
      description: `Create one node, way, or relation inside an open changeset. Returns the new id (version is 1). Referenced nodes/members must already exist; for many related creations use osm_upload_diff. ${NOTE}`,
      inputSchema: z.object({ changeset_id: id, element: element.omit({ id: true, version: true }) }),
      annotations: WRITE,
    },
    safe(async ({ changeset_id, element: e }, ctx) => {
      if (e.type === "node" && (e.lat === undefined || e.lon === undefined)) throw new Error("Nodes need lat and lon.");
      return guard.run(ctx, { elements: 1, what: `create a ${e.type}` }, async () => {
        const out = await osm.send("PUT", `/${e.type}/create`, { body: buildElementXml(e, changeset_id) });
        return { type: e.type, id: Number(out.trim()), version: 1 };
      });
    }),
  );

  server.registerTool(
    "osm_update_element",
    {
      description: `Replace an element's tags and geometry. This is a full replace, not a patch: first read the element with osm_get_element, change what you need, and send back everything including unchanged tags. Returns the new version. ${NOTE}`,
      inputSchema: z.object({ changeset_id: id, element: element.required({ id: true, version: true }) }),
      annotations: WRITE,
    },
    safe(async ({ changeset_id, element: e }, ctx) => {
      if (e.type === "node" && (e.lat === undefined || e.lon === undefined)) throw new Error("Nodes need lat and lon.");
      return guard.run(ctx, { elements: 1, what: `modify ${e.type} ${e.id}` }, async () => {
        const out = await osm.send("PUT", `/${e.type}/${e.id}`, { body: buildElementXml(e, changeset_id) });
        return { type: e.type, id: e.id, version: Number(out.trim()) };
      });
    }),
  );

  server.registerTool(
    "osm_patch_tags",
    {
      description: `Add, change, or remove tags on one element without resending its geometry or other tags. Fetches the current element, merges your changes, and writes it back in the given changeset. Returns old and new tags and the new version; does nothing (and returns changed:false) if the tags would be identical. Use expected_version to fail if someone edited the element since you read it. ${NOTE}`,
      inputSchema: z.object({
        changeset_id: id,
        type: z.enum(["node", "way", "relation"]),
        id,
        set: tags.optional().describe("Tags to add or overwrite"),
        remove: z.array(z.string().max(255)).optional().describe("Tag keys to delete"),
        expected_version: z.number().int().positive().optional(),
      }),
      annotations: WRITE,
    },
    safe(async (a, ctx) => {
      return guard.run(ctx, { elements: 1, what: `change tags on ${a.type} ${a.id}` }, () => patchTags(osm, a), (r) => ({ elements: r.changed ? 1 : 0 }));
    }),
  );

  server.registerTool(
    "osm_delete_element",
    {
      description: `Delete an element. Fails with 412 if it is still referenced by a way or relation. Nodes need their current lat/lon. Returns the new version. ${NOTE}`,
      inputSchema: z.object({ changeset_id: id, element: element.required({ id: true, version: true }) }),
      annotations: DESTRUCTIVE,
    },
    safe(async ({ changeset_id, element: e }, ctx) => {
      return guard.run(
        ctx,
        { elements: 1, what: `delete ${e.type} ${e.id}` },
        async () => {
          const go = await confirmWrite(ctx, cfg, `Delete ${e.type} ${e.id} (version ${e.version}) in changeset ${changeset_id} on ${cfg.env === "dev" ? "the OSM sandbox" : "the real OpenStreetMap"}? The deletion is public and attributed to your account.`);
          if (!go) return NOT_CONFIRMED;
          const out = await osm.send("DELETE", `/${e.type}/${e.id}`, { body: buildElementXml(e, changeset_id) });
          return { type: e.type, id: e.id, deleted: true, version: Number(out.trim()) };
        },
        (r) => ({ elements: r === NOT_CONFIRMED ? 0 : 1 }),
      );
    }),
  );

  server.registerTool(
    "osm_upload_diff",
    {
      description: `Apply many creates/modifies/deletes atomically in one request (osmChange). Use negative ids for new elements and reference them from ways/relations in the same diff; the result maps placeholder ids to real ones. Order: creates, then modifies, then deletes. ${NOTE}`,
      inputSchema: z.object({
        changeset_id: id,
        create: z.array(element).optional(),
        modify: z.array(element).optional(),
        delete: z.array(element).optional(),
      }),
      annotations: DESTRUCTIVE,
    },
    safe(async ({ changeset_id, ...diff }, ctx) => {
      if (!diff.create?.length && !diff.modify?.length && !diff.delete?.length) throw new Error("Diff is empty.");
      const count = (diff.create?.length ?? 0) + (diff.modify?.length ?? 0) + (diff.delete?.length ?? 0);
      return guard.run(
        ctx,
        { elements: count, what: `upload ${count} element change(s) in one diff` },
        async () => {
          if (diff.delete?.length) {
            const n = (a?: unknown[]) => a?.length ?? 0;
            const go = await confirmWrite(ctx, cfg, `Upload to changeset ${changeset_id} on ${cfg.env === "dev" ? "the OSM sandbox" : "the real OpenStreetMap"}: ${n(diff.create)} create, ${n(diff.modify)} modify, ${n(diff.delete)} DELETE? Deletions are public and attributed to your account.`);
            if (!go) return NOT_CONFIRMED;
          }
          const out = await osm.send("POST", `/changeset/${changeset_id}/upload`, { body: buildOsmChangeXml(diff, changeset_id) });
          return { results: parseDiffResult(out) };
        },
        (r) => ({ elements: r === NOT_CONFIRMED ? 0 : count }),
      );
    }),
  );
}
