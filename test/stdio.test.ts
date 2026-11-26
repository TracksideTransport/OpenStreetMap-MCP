import { describe, expect, it } from "vitest";
import { hermeticEnv, startServer } from "./helpers/server.js";

const toolNames = async (s: Awaited<ReturnType<typeof startServer>>): Promise<string[]> => (await s.rpc("tools/list")).result.tools.map((t: any) => t.name);

describe("stdio server", () => {
  it("lists tools, and unauthenticated writes come back as tool errors", async () => {
    const s = await startServer(hermeticEnv);
    try {
      const tools = await toolNames(s);
      for (const n of ["osm_login", "osm_get_element", "osm_get_bbox", "osm_create_changeset", "osm_upload_diff", "osm_patch_tags", "osm_create_note"]) expect(tools).toContain(n);
      expect(tools).not.toContain("osm_geocode");
      const r = await s.raw("osm_create_changeset", { comment: "x" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/osm_login/);
    } finally {
      s.close();
    }
  }, 30_000);

  it("registers geocoding tools only when OSM_ENABLE_GEOCODING is set", async () => {
    const s = await startServer({ ...hermeticEnv, OSM_ENABLE_GEOCODING: "true" });
    try {
      const tools = await toolNames(s);
      expect(tools).toContain("osm_geocode");
      expect(tools).toContain("osm_reverse_geocode");
    } finally {
      s.close();
    }
  }, 30_000);
});
