// Offline stub for the `ws` package.
//
// The real WebSocketServer binds TCP port 7225 at module-load time, which (a)
// fails with EADDRINUSE when a live server is already running and (b) is an
// external side effect we don't want in a unit test. This stub provides just
// enough of the API surface that server.js touches at import time
// (`new WebSocketServer({...})` + `.on(...)`) without opening a socket.
//
// No connection is ever emitted, so the server's `extensionSocket` stays null
// and every sendCommand() rejects with "extension not connected" — which is
// exactly the offline behavior we want for tool-surface introspection.

import { EventEmitter } from "node:events";

export class WebSocketServer extends EventEmitter {
  constructor(_options) {
    super();
    this.options = _options || {};
    this.clients = new Set();
  }
  close(cb) {
    if (typeof cb === "function") cb();
  }
  address() {
    return { port: this.options.port ?? 0, address: "127.0.0.1" };
  }
}

// Minimal WebSocket export in case it is referenced; not used at import time.
export class WebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 3; // CLOSED
  }
  send() {}
  close() {}
}

export default WebSocketServer;
