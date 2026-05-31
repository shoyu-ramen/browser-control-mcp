// Offline stub for @modelcontextprotocol/sdk/server/stdio.js.
//
// The real StdioServerTransport hijacks process.stdin/stdout. We don't want a
// test process talking on real stdio, but we DO want to exercise the genuine
// MCP request handlers (the same `tools/list` path a real client hits) so the
// tool surface we assert against is the live, registered one — not a static
// scrape of source.
//
// So this transport implements the SDK Transport contract and, once the server
// has connected (which sets `this.onmessage`), performs a real in-process
// JSON-RPC handshake: initialize -> notifications/initialized -> tools/list.
// The tools array from the response is published on a shared registry that the
// introspector reads. No sockets, no subprocess, no real stdio.

import { LIVE_REGISTRY } from "../live-registry.mjs";

const PROTOCOL_VERSION = "2025-06-18";

export class StdioServerTransport {
  constructor(_stdin, _stdout) {
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
    this._started = false;
    this._tools = null;
    // A promise the introspector awaits: resolves once tools/list returns.
    this.ready = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
    LIVE_REGISTRY.transport = this;
  }

  async start() {
    if (this._started) {
      throw new Error("StdioServerTransport already started!");
    }
    this._started = true;
    // Drive a real handshake on the next tick so Protocol.connect() has finished
    // wiring this.onmessage before we feed it messages.
    queueMicrotask(() => this._drive().catch((e) => this._rejectReady(e)));
  }

  async _drive() {
    if (typeof this.onmessage !== "function") {
      throw new Error("transport.onmessage was never wired by the server");
    }
    // initialize
    this._deliver({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "clean-core-harness", version: "0.0.0" },
      },
    });
    // initialized notification (no id)
    this._deliver({ jsonrpc: "2.0", method: "notifications/initialized" });
    // tools/list
    this._deliver({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  }

  _deliver(message) {
    // Protocol.onmessage may be sync or async; we don't await it. Responses
    // come back through send().
    this.onmessage(message);
  }

  // The SDK calls send() to emit responses/notifications back to the client.
  async send(message) {
    if (message && message.id === 2 && message.result && Array.isArray(message.result.tools)) {
      this._tools = message.result.tools;
      LIVE_REGISTRY.tools = message.result.tools;
      this._resolveReady(message.result.tools);
    }
    if (message && message.id === 2 && message.error) {
      this._rejectReady(new Error("tools/list errored: " + JSON.stringify(message.error)));
    }
  }

  async close() {
    if (typeof this.onclose === "function") this.onclose();
  }
}

export default StdioServerTransport;
