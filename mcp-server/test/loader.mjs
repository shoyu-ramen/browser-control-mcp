// ESM loader hook that redirects server.js's two side-effecting external
// imports to offline stubs, so importing server.js neither binds TCP port 7225
// (real `ws`) nor hijacks process stdio (real StdioServerTransport).
//
// Everything else — including the real @modelcontextprotocol/sdk McpServer and
// its tool registry — loads unchanged, so the tool surface the harness inspects
// is the genuine registered one.
//
// Installed via `node --import ./test/register-loader.mjs` (module.register),
// which works on Node >= 18.19. For older Node, run with
// `node --loader ./test/loader.mjs` instead.

import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const STUBS = {
  ws: pathToFileURL(join(here, "stubs", "ws.mjs")).href,
  "@modelcontextprotocol/sdk/server/stdio.js": pathToFileURL(
    join(here, "stubs", "stdio.mjs")
  ).href,
};

export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(STUBS, specifier)) {
    return { url: STUBS[specifier], shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
