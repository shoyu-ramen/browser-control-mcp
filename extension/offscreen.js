const WS_URL = "ws://127.0.0.1:7225";
// chrome.runtime.getManifest() is NOT exposed inside offscreen documents on some
// Chrome versions — calling it throws synchronously and aborts this whole script
// before connect() ever runs, so the WebSocket never opens. Guard it, and fall
// back to reading the manifest over the extension URL (which IS available here).
let EXTENSION_VERSION = "";
try {
  EXTENSION_VERSION = chrome.runtime.getManifest().version;
} catch {
  fetch(chrome.runtime.getURL("manifest.json"))
    .then((r) => r.json())
    .then((m) => { EXTENSION_VERSION = m.version || ""; })
    .catch(() => {});
}
let ws = null;
let reconnectTimer = null;

// Single source of truth for connection state. The popup reads this instead of
// pinging the background worker (which can't see the socket and would always
// report "connected").
function setWsState(connected) {
  try {
    chrome.storage.local.set({ wsConnected: !!connected });
  } catch {}
}

function connect() {
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) return;
    if (ws.readyState === WebSocket.CONNECTING) return;
    ws = null;
  }

  try {
    ws = new WebSocket(WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[BrowserControl] Connected to MCP server");
    stopReconnect();
    setWsState(true);
    ws.send(JSON.stringify({ type: "hello", extensionId: chrome.runtime.id, version: EXTENSION_VERSION }));
  };

  ws.onclose = () => {
    ws = null;
    setWsState(false);
    scheduleReconnect();
  };

  ws.onerror = () => {
    try { ws?.close(); } catch {}
    ws = null;
    setWsState(false);
    scheduleReconnect();
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === "ping") {
      ws?.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (msg.type === "command") {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "command",
          id: msg.id,
          command: msg.command,
          params: msg.params,
        });
        ws?.send(JSON.stringify({ type: "response", id: msg.id, result: response }));
      } catch (e) {
        ws?.send(
          JSON.stringify({ type: "response", id: msg.id, result: { success: false, error: e.message } })
        );
      }
    }

    if (msg.type === "subscribe" || msg.type === "unsubscribe") {
      try {
        await chrome.runtime.sendMessage(msg);
      } catch (e) {
        console.error("[BrowserControl] Subscription relay failed:", e.message);
      }
    }
  };
}

// Forward events from background.js to MCP server via WebSocket
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "event" && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
});

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => connect(), 2000);
}

function stopReconnect() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

setWsState(false);
connect();
