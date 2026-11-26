#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./server.js";

const server = createServer();
await server.connect(new StdioServerTransport());
console.error("openstreetmap-mcp running on stdio");
