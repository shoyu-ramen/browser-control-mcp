// Connection runtime: owns the WebSocket bridge to the Chrome extension and
// the request/response plumbing every tool rides on. Importing this module
// binds the WebSocket server on WS_PORT — the same import-time behavior the
// monolithic server.js had (and what the offline test loader stubs out).
import { WebSocketServer } from "ws";
import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EventBus } from "../messaging/event-bus.js";
import { SubscriptionManager } from "../messaging/subscriptions.js";
import { SessionState } from "../messaging/session-state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID_FILE = join(__dirname, "..", ".extension-id");

export const WS_PORT = 7225;
export const SERVER_VERSION = "2.1.0";
let extensionSocket = null;
let extensionId = null;
let pendingRequests = new Map();
let requestId = 0;

const eventBus = new EventBus();
const subscriptions = new SubscriptionManager();
const sessionState = new SessionState();

try { extensionId = readFileSync(EXT_ID_FILE, "utf-8").trim(); } catch {}

const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

wss.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    process.stderr.write(
      `[MCP] Port ${WS_PORT} is already in use — another browser-control server is ` +
        `likely already running. This instance will exit; the existing server keeps ` +
        `serving the Chrome extension. (To replace it, stop the other process first.)\n`
    );
    process.exit(0);
  }
  process.stderr.write(`[MCP] WebSocket server error: ${err.message}\n`);
  process.exit(1);
});

wss.on("connection", (socket) => {
  process.stderr.write("[MCP] Chrome extension connected\n");
  extensionSocket = socket;

  socket.on("close", () => {
    process.stderr.write("[MCP] Chrome extension disconnected\n");
    extensionSocket = null;
    for (const [id, { reject }] of pendingRequests) {
      reject(new Error("Extension disconnected"));
    }
    pendingRequests.clear();
  });

  socket.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.type === "keepalive" || msg.type === "pong") return;

    if (msg.type === "hello" && msg.extensionId) {
      extensionId = msg.extensionId;
      try { writeFileSync(EXT_ID_FILE, extensionId); } catch {}
      process.stderr.write(`[MCP] Extension ID: ${extensionId}\n`);
      if (msg.version && msg.version !== SERVER_VERSION) {
        process.stderr.write(
          `[MCP] WARNING: extension version ${msg.version} does not match server ${SERVER_VERSION}. ` +
            `The loaded Chrome extension may be stale — rebuild and reload it (chrome://extensions → Reload) ` +
            `or some tools may fail with "Unknown command".\n`
        );
      } else if (!msg.version) {
        process.stderr.write(
          `[MCP] WARNING: extension sent no version (pre-2.1.0 build). Reload the extension to silence this.\n`
        );
      }
      return;
    }

    if (msg.type === "response" && pendingRequests.has(msg.id)) {
      const { resolve } = pendingRequests.get(msg.id);
      pendingRequests.delete(msg.id);
      resolve(msg.result);
    }

    if (msg.type === "event") {
      eventBus.push(msg.eventType, msg.data);
      if (msg.eventType === "navigation") {
        sessionState.recordNavigation(msg.data?.url, msg.data?.title);
      }
    }
  });
});

subscriptions.setSender((msg) => {
  if (extensionSocket && extensionSocket.readyState === 1) {
    extensionSocket.send(JSON.stringify(msg));
  }
});

function sendCommand(command, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      reject(
        new Error(
          "Chrome extension not connected. Make sure the extension is installed and the browser is open."
        )
      );
      return;
    }

    const id = ++requestId;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error("Command timed out after " + timeoutMs + "ms"));
    }, timeoutMs);

    pendingRequests.set(id, {
      resolve: (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    sessionState.recordAction({ type: "command", command, params });
    extensionSocket.send(
      JSON.stringify({ type: "command", id, command, params })
    );
  });
}

function formatResult(result) {
  if (!result)
    return { content: [{ type: "text", text: "No response from extension" }] };

  if (result.success) {
    const data =
      typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data, null, 2);
    return { content: [{ type: "text", text: data }] };
  }

  return {
    content: [{ type: "text", text: `Error: ${result.error}` }],
    isError: true,
  };
}

function formatScreenshot(result) {
  if (!result || !result.success) {
    return {
      content: [
        { type: "text", text: result?.error || "Screenshot failed" },
      ],
      isError: true,
    };
  }

  const base64 = result.data.replace(/^data:image\/png;base64,/, "");
  return {
    content: [{ type: "image", data: base64, mimeType: "image/png" }],
  };
}
// Read-only view of the connection state, for the status/wait tools that used
// to close over the module-scope variables in the monolith.
export function isConnected() {
  return !!(extensionSocket && extensionSocket.readyState === 1);
}

export function getConnectionStatus() {
  return {
    connected: isConnected(),
    extensionId: extensionId || null,
    pendingRequests: pendingRequests.size,
  };
}

export { sendCommand, formatResult, formatScreenshot };
