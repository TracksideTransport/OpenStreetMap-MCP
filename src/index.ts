#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config.js";
import { createServer, VERSION } from "./server.js";

const HELP = `openstreetmap-mcp ${VERSION}: MCP server for reading and editing OpenStreetMap

Usage: openstreetmap-mcp [--http] [--port <n>] [--host <addr>] [--public-url <url>]

  (default)          stdio transport, for a local MCP client; log in with the osm_login tool
  --http             Streamable HTTP transport at <public-url>/mcp with MCP OAuth (for remote use)
  --port <n>         HTTP port (default 3000, env OSM_HTTP_PORT)
  --host <addr>      HTTP bind address (default 127.0.0.1, env OSM_HTTP_HOST)
  --public-url <url> externally visible base URL, https unless localhost (env OSM_PUBLIC_URL)

Environment: see https://github.com/sohampatwardhan/OpenStreetMap-MCP#configuration
`;

function parseArgs(argv: string[]): { http: boolean; env: NodeJS.ProcessEnv } {
  const env = { ...process.env };
  let http = env.OSM_MCP_TRANSPORT === "http";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--http") http = true;
    else if (a === "--port") env.OSM_HTTP_PORT = value();
    else if (a === "--host") env.OSM_HTTP_HOST = value();
    else if (a === "--public-url") env.OSM_PUBLIC_URL = value();
    else if (a === "--help" || a === "-h") {
      process.stdout.write(HELP);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}\n\n${HELP}`);
  }
  return { http, env };
}

try {
  const { http, env } = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(env);
  if (http) {
    const { startHttpServer } = await import("./http/app.js"); // loaded lazily: stdio users never pay for express
    await startHttpServer(cfg);
    console.error(`openstreetmap-mcp ${VERSION} listening on ${cfg.http.host}:${cfg.http.port}; MCP endpoint ${cfg.http.publicUrl}/mcp (${cfg.env}: ${cfg.apiBase})`);
    console.error(`OSM OAuth app redirect URI must be: ${cfg.http.publicUrl}/oauth/callback`);
  } else {
    await createServer(cfg).connect(new StdioServerTransport());
    console.error("openstreetmap-mcp running on stdio");
  }
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
