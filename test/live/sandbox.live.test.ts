import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasSandboxToken, liveEnv } from "../helpers/live.js";
import { startServer, type TestServer } from "../helpers/server.js";

/**
 * Live integration tests against the OSM *sandbox* (master.apis.dev.openstreetmap.org).
 * Run with `npm run test:live`. They need a sandbox token: set OSM_ACCESS_TOKEN, or log in once with
 * OSM_ENV=dev and OSM_CLIENT_ID via the osm_login tool (the token is stored and reused).
 * Everything created is deleted again; notes cannot be deleted, so they are closed.
 */
const run = describe.skipIf(!hasSandboxToken());
const stamp = new Date().toISOString();
const tracked: { type: "node" | "way" | "relation"; id: number }[] = [];
let s: TestServer;
let granted: string[] = [];

run("OSM sandbox (live)", () => {
  beforeAll(async () => {
    s = await startServer(liveEnv());
    granted = (await s.call("osm_whoami")).permissions ?? [];
  });

  afterAll(async () => {
    if (!s) return;
    try {
      // Best-effort cleanup of anything a failed test left behind (ways first, then nodes).
      const left: any[] = [];
      for (const t of [...tracked].sort((a) => (a.type === "way" ? -1 : 1))) {
        const r = await s.raw("osm_get_element", t);
        if (r.isError) continue; // already deleted (410) or gone
        const el = JSON.parse(r.content[0].text).elements[0];
        if (el.visible !== false) left.push(el);
      }
      if (left.length) {
        const { changeset_id } = await s.call("osm_create_changeset", { comment: `openstreetmap-mcp live test cleanup ${stamp}` });
        await s.call("osm_upload_diff", {
          changeset_id,
          delete: left.map((e) => ({ type: e.type, id: e.id, version: e.version, lat: e.lat, lon: e.lon })),
        });
        await s.call("osm_close_changeset", { id: changeset_id });
      }
    } finally {
      s.close();
    }
  }, 90_000);

  it("is authenticated against the sandbox with write scopes", async () => {
    const who = await s.call("osm_whoami");
    expect(who.environment).toBe("dev");
    expect(who.api).toContain("master.apis.dev.openstreetmap.org");
    expect(who.authenticated).toBe(true);
    expect(who.permissions).toEqual(expect.arrayContaining(["allow_write_api", "allow_write_notes"]));
  });

  it("reads capabilities and a bounding box", async () => {
    const caps = await s.call("osm_capabilities");
    expect(caps.api.area.maximum).toBeGreaterThan(0);
    // quiet patch of open ocean: valid response, (almost certainly) no elements
    const map = await s.call("osm_get_bbox", { min_lon: -30, min_lat: 30, max_lon: -29.999, max_lat: 30.001 });
    expect(Array.isArray(map.elements)).toBe(true);
    // an oversized box is rejected by the API and surfaced as a readable tool error
    const big = await s.raw("osm_get_bbox", { min_lon: 0, min_lat: 0, max_lon: 5, max_lat: 5 });
    expect(big.isError).toBe(true);
    expect(big.content[0].text).toMatch(/HTTP 400/);
  });

  it("runs a full changeset lifecycle: create, patch, update, diff, delete, close, comment", async () => {
    const { changeset_id: cs } = await s.call("osm_create_changeset", { comment: `openstreetmap-mcp live test ${stamp}`, source: "test" });
    expect(cs).toBeGreaterThan(0);

    // create + read
    const bench = await s.call("osm_create_element", { changeset_id: cs, element: { type: "node", lat: 0.001, lon: 0.001, tags: { amenity: "bench" } } });
    tracked.push({ type: "node", id: bench.id });
    expect(bench.version).toBe(1);

    // patch tags (osm_patch_tags): adds one, keeps the rest, geometry untouched
    const patched = await s.call("osm_patch_tags", { changeset_id: cs, type: "node", id: bench.id, set: { backrest: "yes" }, expected_version: 1 });
    expect(patched).toMatchObject({ changed: true, version: 2, new_tags: { amenity: "bench", backrest: "yes" } });
    const afterPatch = (await s.call("osm_get_element", { type: "node", id: bench.id })).elements[0];
    expect(afterPatch).toMatchObject({ version: 2, lat: 0.001, lon: 0.001, tags: { amenity: "bench", backrest: "yes" } });

    // no-op patch writes nothing
    const noop = await s.call("osm_patch_tags", { changeset_id: cs, type: "node", id: bench.id, set: { amenity: "bench" } });
    expect(noop).toMatchObject({ changed: false, version: 2 });

    // stale version guard
    const stale = await s.raw("osm_patch_tags", { changeset_id: cs, type: "node", id: bench.id, set: { a: "b" }, expected_version: 1 });
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toMatch(/Version conflict/);

    // full replace
    const upd = await s.call("osm_update_element", { changeset_id: cs, element: { type: "node", id: bench.id, version: 2, lat: 0.001, lon: 0.001, tags: { amenity: "bench", material: "wood" } } });
    expect(upd.version).toBe(3);

    // atomic diff with placeholder ids
    const diff = await s.call("osm_upload_diff", {
      changeset_id: cs,
      create: [
        { type: "node", id: -1, lat: 0.002, lon: 0.002 },
        { type: "node", id: -2, lat: 0.002, lon: 0.003 },
        { type: "way", id: -3, nodes: [-1, -2], tags: { highway: "path" } },
      ],
    });
    const ids = Object.fromEntries(diff.results.map((r: any) => [r.old_id, r.new_id]));
    expect(Object.keys(ids).sort()).toEqual(["-1", "-2", "-3"]);
    tracked.push({ type: "way", id: ids["-3"] }, { type: "node", id: ids["-1"] }, { type: "node", id: ids["-2"] });

    const full = await s.call("osm_get_element_full", { type: "way", id: ids["-3"] });
    expect(full.elements.map((e: any) => e.type).sort()).toEqual(["node", "node", "way"]);
    const parents = await s.call("osm_element_parents", { type: "node", id: ids["-1"], parent: "ways" });
    expect(parents.elements[0].id).toBe(ids["-3"]);
    const hist = await s.call("osm_element_history", { type: "node", id: bench.id });
    expect(hist.elements.map((e: any) => e.version)).toEqual([1, 2, 3]);

    // a still-referenced node cannot be deleted (precondition failed)
    const refused = await s.raw("osm_delete_element", { changeset_id: cs, element: { type: "node", id: ids["-1"], version: 1, lat: 0.002, lon: 0.002 } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/412/);

    // delete everything atomically, then the bench
    await s.call("osm_upload_diff", {
      changeset_id: cs,
      delete: [
        { type: "way", id: ids["-3"], version: 1 },
        { type: "node", id: ids["-1"], version: 1, lat: 0.002, lon: 0.002 },
        { type: "node", id: ids["-2"], version: 1, lat: 0.002, lon: 0.003 },
      ],
    });
    const del = await s.call("osm_delete_element", { changeset_id: cs, element: { type: "node", id: bench.id, version: 3, lat: 0.001, lon: 0.001 } });
    expect(del).toMatchObject({ deleted: true, version: 4 });

    // gone from reads
    expect((await s.raw("osm_get_element", { type: "node", id: bench.id })).isError).toBe(true);

    // close, then comment (OSM only accepts comments on closed changesets)
    const early = await s.raw("osm_comment_changeset", { id: cs, text: "too early" });
    expect(early.isError).toBe(true);
    await s.call("osm_update_changeset_tags", { id: cs, tags: { comment: `openstreetmap-mcp live test ${stamp} (done)`, created_by: "openstreetmap-mcp" } });
    await s.call("osm_close_changeset", { id: cs });
    await s.call("osm_comment_changeset", { id: cs, text: "live test comment" });

    const cj = await s.call("osm_get_changeset", { id: cs, include_discussion: true });
    const meta = cj.elements?.[0] ?? cj.changeset ?? cj;
    // create bench, patch, update, 3 diff creates, 3 diff deletes, delete bench
    expect(meta.changes_count).toBe(10);
    expect(meta.open).toBe(false);
    expect(await s.call("osm_get_changeset_diff", { id: cs })).toContain("<osmChange");
  });

  it("runs a map notes lifecycle: create, comment, close, reopen, close, search", async () => {
    const text = `openstreetmap-mcp live test note ${stamp}`;
    const note = await s.call("osm_create_note", { lat: 0.01, lon: 0.01, text });
    const id = note.properties.id;
    expect(note.properties.status).toBe("open");
    try {
      const c = await s.call("osm_comment_note", { id, text: "a comment" });
      expect(c.properties.comments.length).toBe(2);
      expect((await s.call("osm_close_note", { id, text: "closing" })).properties.status).toBe("closed");
      expect((await s.call("osm_reopen_note", { id, text: "reopening" })).properties.status).toBe("open");
      const got = await s.call("osm_get_note", { id });
      expect(got.properties.comments.length).toBe(4);
      const inBox = await s.call("osm_get_notes_in_bbox", { min_lon: 0.005, min_lat: 0.005, max_lon: 0.015, max_lat: 0.015, closed: -1 });
      expect(inBox.features.some((f: any) => f.properties.id === id)).toBe(true);
    } finally {
      await s.call("osm_close_note", { id }).catch(() => {}); // notes cannot be deleted; always leave closed
    }
    expect((await s.call("osm_get_note", { id })).properties.status).toBe("closed");
  });
  it("runs a preferences lifecycle: set, get one, get all, delete", async (ctx) => {
    if (!granted.includes("allow_write_prefs") || !granted.includes("allow_read_prefs")) return ctx.skip();
    const key = `openstreetmap-mcp-live-${Date.now()}`;
    try {
      expect(await s.call("osm_set_preference", { key, value: "hello" })).toEqual({ key, value: "hello" });
      expect(await s.call("osm_get_preferences", { key })).toEqual({ key, value: "hello" });
      expect((await s.call("osm_get_preferences")).preferences[key]).toBe("hello");
      await s.call("osm_set_preference", { key, value: "changed" });
      expect((await s.call("osm_get_preferences", { key })).value).toBe("changed");
      expect(await s.call("osm_delete_preference", { key })).toEqual({ deleted: key });
      expect((await s.raw("osm_get_preferences", { key })).isError).toBe(true);
      // dot-only keys never reach the API
      expect((await s.raw("osm_set_preference", { key: "..", value: "x" })).isError).toBe(true);
    } finally {
      await s.call("osm_delete_preference", { key }).catch(() => {});
    }
  });

  it("runs a GPX lifecycle: upload (trackable), list, details, update, delete", async (ctx) => {
    if (!granted.includes("allow_write_gpx") || !granted.includes("allow_read_gpx")) return ctx.skip();
    const gpx = `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="openstreetmap-mcp live test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>live test</name><trkseg>${[0, 1, 2]
      .map((i) => `<trkpt lat="${(0.01 + i * 0.0001).toFixed(4)}" lon="${(0.01 + i * 0.0001).toFixed(4)}"><ele>1</ele><time>2026-01-01T00:00:0${i}Z</time></trkpt>`)
      .join("")}</trkseg></trk></gpx>`;
    let id: number | undefined;
    try {
      const up = await s.call("osm_upload_gpx", { gpx, description: `openstreetmap-mcp live test ${stamp}`, tags: ["live-test"], filename: "live-test.gpx", visibility: "trackable" });
      id = up.gpx_id;
      expect(up).toMatchObject({ visibility: "trackable" });
      expect(id).toBeGreaterThan(0);

      const mine = await s.call("osm_list_my_gpx_files");
      expect(mine.traces.map((t: any) => t.id)).toContain(id);

      const details = await s.call("osm_get_gpx_details", { id });
      const f = details.trace;
      expect(f.visibility).toBe("trackable");
      expect(String(f.description)).toContain("live test");

      const upd = await s.call("osm_update_gpx", { id, description: `updated ${stamp}`, tags: ["live-test", "updated"] });
      expect(upd).toMatchObject({ id, visibility: "trackable", tags: ["live-test", "updated"] });
      const after = (await s.call("osm_get_gpx_details", { id })).trace;
      const f2 = after;
      expect(String(f2.description)).toContain("updated");
      expect(f2.tags).toEqual(["live-test", "updated"]);

      // points are processed asynchronously; only check them if the sandbox already did
      if (f2.pending === false || f2.pending === "false") {
        const data = await s.call("osm_get_gpx_data", { id });
        expect(data.total_points).toBe(3);
      }
    } finally {
      if (id !== undefined) {
        expect(await s.call("osm_delete_gpx", { id })).toEqual({ deleted: id });
        expect((await s.raw("osm_get_gpx_details", { id })).isError).toBe(true);
      }
    }
  });

});
