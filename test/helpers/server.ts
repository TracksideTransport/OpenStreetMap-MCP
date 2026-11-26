import { spawn } from "node:child_process";

export type Rpc = (method: string, params?: object) => Promise<any>;

export interface TestServer {
  rpc: Rpc;
  /** Call a tool; returns parsed JSON (or text) and throws on isError. */
  call: (name: string, args?: object) => Promise<any>;
  /** Call a tool and return the raw MCP result (does not throw on isError). */
  raw: (name: string, args?: object) => Promise<any>;
  close: () => void;
}

/** Spawns the real server over stdio and speaks raw JSON-RPC. */
export async function startServer(extraEnv: Record<string, string | undefined> = {}, inherit = process.env): Promise<TestServer> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...inherit, ...extraEnv })) if (v !== undefined) env[k] = v;
  const child = spawn("npx", ["tsx", "src/index.ts"], { stdio: ["pipe", "pipe", "pipe"], env });
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
  const rpc: Rpc = async (method, params = {}) => {
    const id = ++n;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    for (let i = 0; i < 1200; i++) {
      const f = lines.find((m) => m.id === id);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no response to ${method}`);
  };
  const raw = async (name: string, args: object = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  const call = async (name: string, args: object = {}) => {
    const r = await raw(name, args);
    const text: string = r.content[0].text;
    if (r.isError) throw new Error(`${name}: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { rpc, call, raw, close: () => child.kill() };
}

/** Hermetic server for default tests: no token, no stored config, geocoding off unless overridden. */
export const hermeticEnv = { OSM_CONFIG_DIR: "/nonexistent-osm-mcp-test", OSM_ACCESS_TOKEN: "", OSM_ENABLE_GEOCODING: "" };
