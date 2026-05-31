// Loads the real server.js (with `ws` + stdio stubbed by the loader) and
// returns the LIVE registered tool surface, obtained the same way a real MCP
// client would: by issuing a tools/list request against the running server.
//
// This deliberately does NOT scrape server.js source or reach into SDK
// internals — it reflects exactly what the guard at the top of server.js lets
// through to clients, so a regression that re-registers a blocked tool will
// show up here.

import { LIVE_REGISTRY } from "./live-registry.mjs";

let cached = null;

export async function getRegisteredTools() {
  if (cached) return cached;

  // Importing server.js runs its top-level code, including `await
  // server.connect(transport)`. Our stub transport drives initialize +
  // tools/list and publishes the result on LIVE_REGISTRY.
  await import("../server.js");

  const transport = LIVE_REGISTRY.transport;
  if (!transport) {
    throw new Error(
      "Stub transport was never constructed — is the loader installed and did server.js call new StdioServerTransport()?"
    );
  }

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out waiting for tools/list from server")),
      10000
    );
  });

  let tools;
  try {
    tools = await Promise.race([transport.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }

  cached = {
    tools, // full tool objects: { name, description, inputSchema, ... }
    names: tools.map((t) => t.name).sort(),
  };
  return cached;
}
