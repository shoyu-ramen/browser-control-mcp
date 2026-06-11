// Free/Pro entitlement gate — regression tests.
//
// The gate lives in lib/mcp.js (the registration seam): Pro tools keep their
// registration (all 138 tools stay visible) but their HANDLER asks the
// extension for the current tier (get_license_status) and answers a friendly
// upgrade moment on the free tier. These tests drive real tools/call requests
// against a mock extension socket, reusing the integration harness stubs.
//
// Run via:  npm test   (installs the offline loader; see package.json)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { getRegisteredTools } from "./introspect.mjs";
import { LIVE_REGISTRY } from "./live-registry.mjs";
import { WS_REGISTRY } from "./stubs/ws.mjs";
import {
  isProTool,
  PRO_TOOLS,
  PRO_TOOL_PREFIXES,
  __resetTierCacheForTests,
} from "../lib/mcp.js";

// Locked Pro-surface size (REVENUE-PLAN F1): 10 devtools_* + 8 dev_* + 29
// named tools. Change ONLY as a deliberate pricing/packaging decision.
const EXPECTED_PRO_TOOL_COUNT = 47;

function makeMockSocket() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket._responder = null;
  socket.send = (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    socket.sent.push(msg);
    if (msg.type === "command" && typeof socket._responder === "function") {
      const result = socket._responder(msg);
      if (result !== undefined) {
        queueMicrotask(() =>
          socket.emit("message", JSON.stringify({ type: "response", id: msg.id, result }))
        );
      }
    }
  };
  socket.respondWith = (fn) => {
    socket._responder = fn;
  };
  return socket;
}

function connect() {
  const socket = makeMockSocket();
  const wss = WS_REGISTRY.servers.at(-1);
  assert.ok(wss, "no WebSocketServer was constructed — is the ws stub loaded?");
  wss.emit("connection", socket);
  return socket;
}

async function callTool(name, args = {}) {
  const transport = LIVE_REGISTRY.transport;
  assert.ok(transport, "stub transport missing — server.js did not connect");
  return transport.request("tools/call", { name, arguments: args });
}

// Answer get_license_status with the given tier and everything else with ok.
function tierResponder(tier) {
  return (msg) =>
    msg.command === "get_license_status"
      ? { success: true, data: { tier } }
      : { success: true, data: "ok" };
}

// ── Pro-surface membership ───────────────────────────────────────────────────

test("gate: every explicitly listed Pro tool is a registered tool (no typos)", async () => {
  const { names } = await getRegisteredTools();
  const live = new Set(names);
  const ghosts = [...PRO_TOOLS].filter((n) => !live.has(n));
  assert.deepEqual(ghosts, [], `PRO_TOOLS entries that match no registered tool: ${ghosts.join(", ")}`);
});

test("gate: Pro surface is EXACTLY the locked count; core drive tools stay free", async () => {
  const { names } = await getRegisteredTools();
  const gated = names.filter(isProTool);
  assert.equal(
    gated.length,
    EXPECTED_PRO_TOOL_COUNT,
    `Pro tool count ${gated.length} != locked ${EXPECTED_PRO_TOOL_COUNT}. ` +
      `Changing the free/Pro split is a pricing decision — update the pin deliberately.`
  );
  // The free tier must keep the core read/drive surface.
  for (const free of ["browser_navigate", "browser_click", "browser_fill_field", "browser_screenshot", "browser_get_tab_info", "keyboard_shortcut"]) {
    assert.ok(!isProTool(free), `${free} must stay on the free tier`);
  }
  // And the prefixes must actually match something (catch a renamed family).
  for (const p of PRO_TOOL_PREFIXES) {
    assert.ok(names.some((n) => n.startsWith(p)), `no registered tool matches Pro prefix ${p}`);
  }
});

// ── Gating behavior ──────────────────────────────────────────────────────────

test("gate: free tier gets a friendly upgrade moment, command never reaches the extension", async () => {
  __resetTierCacheForTests();
  const socket = connect();
  socket.respondWith(tierResponder("free"));

  const res = await callTool("browser_save_pdf");

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Pro tool/);
  assert.match(res.content[0].text, /lemonsqueezy\.com\/checkout/);
  const commands = socket.sent.filter((m) => m.type === "command").map((m) => m.command);
  assert.deepEqual(commands, ["get_license_status"], "only the tier query may hit the extension");
});

test("gate: pro tier passes straight through to the extension", async () => {
  __resetTierCacheForTests();
  const socket = connect();
  socket.respondWith(tierResponder("pro"));

  const res = await callTool("browser_save_pdf");

  assert.ok(!res.isError, `expected pass-through, got: ${res.content?.[0]?.text}`);
  const commands = socket.sent.filter((m) => m.type === "command").map((m) => m.command);
  assert.deepEqual(commands, ["get_license_status", "save_pdf"]);
});

test("gate: tier query failure fails OPEN (version-skewed extension is never paywalled)", async () => {
  __resetTierCacheForTests();
  const socket = connect();
  socket.respondWith((msg) =>
    msg.command === "get_license_status"
      ? { success: false, error: "Unknown command: get_license_status" }
      : { success: true, data: "ok" }
  );

  const res = await callTool("devtools_console_log");
  assert.ok(!res.isError, `expected fail-open pass-through, got: ${res.content?.[0]?.text}`);
});

test("gate: free tools never trigger a tier query", async () => {
  __resetTierCacheForTests();
  const socket = connect();
  socket.respondWith(tierResponder("free"));

  const res = await callTool("browser_navigate", { url: "https://example.test" });

  assert.ok(!res.isError);
  const commands = socket.sent.filter((m) => m.type === "command").map((m) => m.command);
  assert.deepEqual(commands, ["navigate"], "ungated tools must not pay the tier-query roundtrip");
});

test("gate: tier is cached briefly, reset makes an upgrade take effect", async () => {
  __resetTierCacheForTests();
  const socket = connect();
  socket.respondWith(tierResponder("free"));

  let res = await callTool("browser_extract_table");
  assert.equal(res.isError, true);

  // User activates Pro: the responder flips, but the cached "free" still gates…
  socket.respondWith(tierResponder("pro"));
  res = await callTool("browser_extract_table");
  assert.equal(res.isError, true, "tier cache should still answer free");

  // …until the cache expires (simulated via the test reset hook).
  __resetTierCacheForTests();
  res = await callTool("browser_extract_table");
  assert.ok(!res.isError);
});
