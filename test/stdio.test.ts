import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

// Spawns the real server over stdio and speaks raw JSON-RPC.
describe("stdio server", () => {
  it("initializes and lists tools", async () => {
    const child = spawn("npx", ["tsx", "src/index.ts"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, OSM_CONFIG_DIR: "/nonexistent-osm-mcp-test", OSM_ACCESS_TOKEN: "" } });
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
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + "\n");
    const waitFor = async (id: number) => {
      for (let i = 0; i < 200; i++) {
        const f = lines.find((m) => m.id === id);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no response ${id}`);
    };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      const init = await waitFor(1);
      expect(init.result.serverInfo.name).toBe("openstreetmap-mcp");
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = (await waitFor(2)).result.tools.map((t: any) => t.name);
      for (const n of ["osm_login", "osm_get_element", "osm_get_bbox", "osm_create_changeset", "osm_upload_diff", "osm_patch_tags", "osm_create_note"]) expect(tools).toContain(n);
      // Unauthenticated write must come back as a tool error, not a crash.
      send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "osm_create_changeset", arguments: { comment: "x" } } });
      const call = (await waitFor(3)).result;
      expect(call.isError).toBe(true);
      expect(call.content[0].text).toMatch(/osm_login/);
    } finally {
      child.kill();
    }
  }, 30_000);
});
