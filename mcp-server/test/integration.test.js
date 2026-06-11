// Server <-> protocol integration tests.
//
// These exercise the real seam between the MCP request handlers and the Chrome
// extension over the WebSocket protocol — the path no other test covers:
//
//   tools/call (real SDK handler)  ->  sendCommand()  ->  ws.send(framed cmd)
//        <- formatResult/formatScreenshot <- {type:"response", id} <-
//
// It reuses the offline loader (so the real server.js + SDK load, but `ws`
// binds no port and stdio isn't hijacked). Two stub extensions make this
// possible without a browser:
//   - stubs/ws.mjs exposes WS_REGISTRY so we can emit a synthetic "connection"
//     with a mock extension socket.
//   - stubs/stdio.mjs exposes transport.request() so we can drive a genuine
//     `tools/call` JSON-RPC request through the registered handlers.
//
// Run via:  npm test   (installs the loader; see package.json)

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { getRegisteredTools } from "./introspect.mjs";
import { LIVE_REGISTRY } from "./live-registry.mjs";
import { WS_REGISTRY } from "./stubs/ws.mjs";

const tick = () => new Promise((r) => setImmediate(r));

// A mock extension socket: an EventEmitter (so server.js can `.on("message")`
// / `.on("close")` it) that records framed commands the server sends and can
// auto-reply via a configurable responder. Mirrors the real extension's side
// of the protocol without a browser.
function makeMockSocket() {
  const socket = new EventEmitter();
  socket.readyState = 1; // OPEN (sendCommand requires readyState === 1)
  socket.sent = []; // parsed command frames the server sent us
  socket._responder = null; // (cmd) => result | undefined

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
        // Reply on the next tick, like a real async round-trip, echoing the id.
        queueMicrotask(() =>
          socket.emit(
            "message",
            JSON.stringify({ type: "response", id: msg.id, result })
          )
        );
      }
    }
  };
  socket.respondWith = (fn) => {
    socket._responder = fn;
  };
  socket.disconnect = () => {
    socket.readyState = 3; // CLOSED
    socket.emit("close");
  };
  return socket;
}

// Connect a fresh mock socket to the server's WebSocketServer.
function connect() {
  const socket = makeMockSocket();
  const wss = WS_REGISTRY.servers.at(-1);
  assert.ok(wss, "no WebSocketServer was constructed — is the ws stub loaded?");
  wss.emit("connection", socket);
  return socket;
}

// Drive a real tools/call through the registered handlers.
async function callTool(name, args = {}) {
  const transport = LIVE_REGISTRY.transport;
  assert.ok(transport, "stub transport missing — server.js did not connect");
  return transport.request("tools/call", { name, arguments: args });
}

// Ensure server.js is loaded and the initialize/tools/list handshake finished
// (this also populates LIVE_REGISTRY.transport and WS_REGISTRY) before any test
// runs. No connection is emitted here — the not-connected test relies on that.
test("integration: setup — server loads with no extension connected", async () => {
  const { names } = await getRegisteredTools();
  assert.ok(names.length > 0, "expected a registered tool surface");
});

test("integration: tool call with NO extension connected rejects cleanly", async () => {
  // No connect() yet, so extensionSocket is null and sendCommand must reject.
  const res = await callTool("browser_get_tab_info");
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /not connected/i);
});

test("integration: command framing, id correlation, and success result", async () => {
  const socket = connect();
  socket.respondWith(() => ({
    success: true,
    data: { url: "https://x.test", title: "X" },
  }));

  const res = await callTool("browser_get_tab_info");

  // The server framed exactly one command with the right protocol shape.
  const cmd = socket.sent.at(-1);
  assert.equal(cmd.type, "command");
  assert.equal(cmd.command, "get_active_tab_info");
  assert.equal(typeof cmd.id, "number");

  // formatResult stringified the success data into a text content block.
  assert.equal(res.content[0].type, "text");
  assert.match(res.content[0].text, /https:\/\/x\.test/);
  assert.ok(!res.isError);
});

test("integration: tool arguments pass through to command params", async () => {
  const socket = connect();
  socket.respondWith(() => ({ success: true, data: "ok" }));

  await callTool("browser_navigate", { url: "https://example.test/page" });

  const cmd = socket.sent.at(-1);
  assert.equal(cmd.command, "navigate");
  assert.deepEqual(cmd.params, { url: "https://example.test/page" });
});

test("integration: error result is shaped by formatResult", async () => {
  const socket = connect();
  socket.respondWith(() => ({ success: false, error: "boom" }));

  const res = await callTool("browser_get_tab_info");
  assert.equal(res.isError, true);
  assert.equal(res.content[0].type, "text");
  assert.equal(res.content[0].text, "Error: boom");
});

test("integration: screenshot success is shaped by formatScreenshot (image, prefix stripped)", async () => {
  const socket = connect();
  socket.respondWith((cmd) =>
    cmd.command === "take_screenshot"
      ? { success: true, data: "data:image/png;base64,AAAB" }
      : undefined
  );

  const res = await callTool("browser_screenshot");
  assert.equal(res.content[0].type, "image");
  assert.equal(res.content[0].mimeType, "image/png");
  assert.equal(res.content[0].data, "AAAB"); // data: prefix stripped
});

test("integration: message router ignores keepalive/pong/events and mismatched ids", async () => {
  const socket = connect();
  socket.respondWith(() => undefined); // we drive every reply manually

  const p = callTool("browser_get_tab_info");
  let settled = false;
  p.then(
    () => (settled = true),
    () => (settled = true)
  );

  await tick(); // let the command get framed
  const cmd = socket.sent.at(-1);
  assert.equal(cmd.command, "get_active_tab_info");

  // Noise that must NOT resolve the pending request:
  socket.emit("message", JSON.stringify({ type: "keepalive" }));
  socket.emit("message", JSON.stringify({ type: "pong" }));
  // An inbound event also exercises the eventBus/sessionState wiring branch.
  socket.emit(
    "message",
    JSON.stringify({
      type: "event",
      eventType: "navigation",
      data: { url: "https://nav.test", title: "Nav" },
    })
  );
  socket.emit("message", "not json at all");
  socket.emit(
    "message",
    JSON.stringify({ type: "response", id: cmd.id + 9999, result: { success: true, data: "wrong" } })
  );

  await tick();
  assert.equal(settled, false, "request resolved on the wrong message — router is leaky");

  // The correctly-correlated response resolves it.
  socket.emit(
    "message",
    JSON.stringify({ type: "response", id: cmd.id, result: { success: true, data: "right" } })
  );
  const res = await p;
  assert.match(res.content[0].text, /right/);
});

test("integration: pending command rejects when the extension disconnects", async () => {
  const socket = connect();
  socket.respondWith(() => undefined); // never replies on its own

  const p = callTool("browser_get_tab_info");
  await tick(); // ensure the command is registered as pending
  assert.equal(socket.sent.at(-1).command, "get_active_tab_info");

  socket.disconnect(); // server's close handler should reject all pending

  const res = await p;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /disconnect/i);
});
