#!/usr/bin/env node
// Browser Control MCP server — entrypoint.
//
// The former monolith is split into modules:
//   lib/runtime.js  WebSocket bridge to the extension + sendCommand/formatters
//   lib/mcp.js      McpServer instance + the BLOCKED_TOOL registration gate
//   tools/*.js      domain tool registrations (import order = registration order)
//
// Importing the tool modules registers the full clean-core surface; nothing
// else registers tools, and every registration flows through lib/mcp.js.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./lib/mcp.js";
import { WS_PORT } from "./lib/runtime.js";

import "./tools/core.js";
import "./tools/devtools.js";
import "./tools/keyboard.js";
import "./tools/dev.js";
import "./tools/extended.js";

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `[MCP] Browser control server running, WebSocket on port ${WS_PORT}\n`
);
