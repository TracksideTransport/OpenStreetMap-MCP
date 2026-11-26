import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

/** Spawns the real server over stdio and speaks raw JSON-RPC. */
async function withServer<T>(extraEnv: Record<string, string>, fn: (rpc: (method: string, params?: object) => Promise<any>) => Promise<T>): Promise<T> {
  const child = spawn("npx", ["tsx", "src/index.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, OSM_CONFIG_DIR: "/nonexistent-osm-mcp-test", OSM_ACCESS_TOKEN: "", OSM_ENABLE_GEOCODING: "", ...extraEnv },
  });
  const lines: any[] = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) lines.push(JSON.parse(l));
    }
  });
  let n = 0;
  const rpc = async (method: string, params: object = {}) => {
    const id = ++n;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 200; i++) {
      const f = lines.find((m) => m.id === id);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no response to ${method}`);
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await fn(rpc);
  } finally {
    child.kill();
  }
}

const toolNames = async (rpc: (m: string, p?: object) => Promise<any>): Promise<string[]> => (await rpc("tools/list")).result.tools.map((t: any) => t.name);

describe("stdio server", () => {
  it("lists tools, and unauthenticated writes come back as tool errors", async () => {
    await withServer({}, async (rpc) => {
      const tools = await toolNames(rpc);
      for (const n of ["osm_login", "osm_get_element", "osm_get_bbox", "osm_create_changeset", "osm_upload_diff", "osm_patch_tags", "osm_create_note"]) expect(tools).toContain(n);
      expect(tools).not.toContain("osm_geocode");
      const call = (await rpc("tools/call", { name: "osm_create_changeset", arguments: { comment: "x" } })).result;
      expect(call.isError).toBe(true);
      expect(call.content[0].text).toMatch(/osm_login/);
    });
  }, 30_000);

  it("registers geocoding tools only when OSM_ENABLE_GEOCODING is set", async () => {
    await withServer({ OSM_ENABLE_GEOCODING: "true" }, async (rpc) => {
      const tools = await toolNames(rpc);
      expect(tools).toContain("osm_geocode");
      expect(tools).toContain("osm_reverse_geocode");
    });
  }, 30_000);
});
