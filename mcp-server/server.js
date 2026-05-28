#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { randomBytes, createHmac } from "crypto";
import { EventBus } from "./messaging/event-bus.js";
import { SubscriptionManager } from "./messaging/subscriptions.js";
import { WorkflowEngine } from "./messaging/workflows.js";
import { SessionState } from "./messaging/session-state.js";
import { registerAgentTools } from "./agent-tools.js";
import { MessageBus } from "./messaging/message-bus.js";
import { AgentRegistry } from "./messaging/agent-registry.js";
import { SharedStateStore } from "./messaging/shared-state.js";
import { AgentTransport } from "./messaging/agent-transport.js";
import { TaskQueue } from "./messaging/task-queue.js";
import { AgentFactory } from "./messaging/agent-factory.js";
import { registerNetworkTools } from "./network-tools.js";
import { registerVideoTools } from "./video-tools.js";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID_FILE = join(__dirname, ".extension-id");

const WS_PORT = 7225;
let extensionSocket = null;
let extensionId = null;
let pendingRequests = new Map();
let requestId = 0;

const eventBus = new EventBus();
const subscriptions = new SubscriptionManager();
const sessionState = new SessionState();
const videoChunkBuffers = new Map();

try { extensionId = readFileSync(EXT_ID_FILE, "utf-8").trim(); } catch {}

const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });

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

    if (msg.type === "video_chunk") {
      const { recordingId, chunkIndex, data, final } = msg;
      if (!videoChunkBuffers.has(recordingId)) {
        videoChunkBuffers.set(recordingId, { chunks: [], startedAt: Date.now() });
      }
      const buf = videoChunkBuffers.get(recordingId);
      if (data) buf.chunks.push(Buffer.from(data, "base64"));
      if (final) {
        buf.complete = true;
        buf.completedAt = Date.now();
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

const server = new McpServer({
  name: "browser-control",
  version: "2.0.0",
});

// --- Tab info ---

server.tool(
  "browser_get_tab_info",
  "Get the URL and title of the active browser tab",
  {},
  async () => formatResult(await sendCommand("get_active_tab_info"))
);

server.tool(
  "browser_list_tabs",
  "List all open browser tabs with their URLs, titles, and IDs",
  {},
  async () => formatResult(await sendCommand("list_tabs"))
);

server.tool(
  "browser_switch_tab",
  "Switch to a browser tab by tab ID or URL/title pattern",
  {
    tabId: z.number().optional().describe("Tab ID to switch to"),
    urlPattern: z
      .string()
      .optional()
      .describe("URL substring or title to match (case-insensitive)"),
  },
  async ({ tabId, urlPattern }) =>
    formatResult(await sendCommand("switch_tab", { tabId, urlPattern }))
);

// --- Navigation ---

server.tool(
  "browser_navigate",
  "Navigate the active tab to a URL",
  {
    url: z.string().describe("The URL to navigate to"),
  },
  async ({ url }) => formatResult(await sendCommand("navigate", { url }))
);

server.tool(
  "browser_wait_for_load",
  "Wait for the active tab to finish loading",
  {
    timeoutMs: z
      .number()
      .optional()
      .describe("Max wait time in ms (default 15000)"),
  },
  async ({ timeoutMs }) =>
    formatResult(await sendCommand("wait_for_load", { timeoutMs }, (timeoutMs || 15000) + 2000))
);

server.tool(
  "browser_wait_for_element",
  "Wait for an element matching a CSS selector to appear on the page",
  {
    selector: z.string().describe("CSS selector to wait for"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Max wait time in ms (default 10000)"),
  },
  async ({ selector, timeoutMs }) =>
    formatResult(
      await sendCommand(
        "wait_for_element",
        { selector, timeoutMs },
        (timeoutMs || 10000) + 2000
      )
    )
);

// --- Form interaction ---

server.tool(
  "browser_get_form_fields",
  "List all visible form fields (inputs, textareas, selects) on the active tab with their selectors, labels, and current values",
  {},
  async () => formatResult(await sendCommand("get_form_fields"))
);

server.tool(
  "browser_fill_field",
  "Fill a form field on the active tab (React-compatible)",
  {
    selector: z.string().describe("CSS selector for the input/textarea element"),
    value: z.string().describe("The text value to fill in"),
  },
  async ({ selector, value }) =>
    formatResult(await sendCommand("fill_field", { selector, value }))
);

server.tool(
  "browser_click",
  "Click an element on the active tab (auto-scrolls into view first)",
  {
    selector: z.string().describe("CSS selector for the element to click"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("click_element", { selector }))
);

server.tool(
  "browser_select_option",
  "Select an option in a <select> dropdown on the active tab",
  {
    selector: z.string().describe("CSS selector for the <select> element"),
    value: z.string().describe("The option value to select"),
  },
  async ({ selector, value }) =>
    formatResult(await sendCommand("select_option", { selector, value }))
);

// --- Page reading ---

server.tool(
  "browser_get_text",
  "Get the text content of an element on the active tab",
  {
    selector: z
      .string()
      .optional()
      .describe("CSS selector (defaults to body if omitted)"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("get_page_content", { selector }))
);

server.tool(
  "browser_execute_js",
  "Execute arbitrary JavaScript on the active tab and return the result",
  {
    code: z.string().describe("JavaScript code to execute in the page context"),
  },
  async ({ code }) => formatResult(await sendCommand("execute_js", { code }))
);

// --- Scroll ---

server.tool(
  "browser_scroll_to",
  "Scroll to an element or to the bottom of the page",
  {
    selector: z
      .string()
      .optional()
      .describe("CSS selector to scroll to (omit to scroll to bottom)"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("scroll_to", { selector }))
);

server.tool(
  "browser_scroll_by",
  "Scroll the page or a specific element by direction and amount. Supports up, down, left, right, top (jump to top), and bottom (jump to bottom).",
  {
    direction: z
      .enum(["up", "down", "left", "right", "top", "bottom"])
      .optional()
      .describe("Scroll direction (default: down)"),
    amount: z
      .number()
      .optional()
      .describe("Pixels to scroll (default 500, ignored for top/bottom)"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector of a scrollable container (defaults to the page)"),
  },
  async ({ direction, amount, selector }) =>
    formatResult(await sendCommand("scroll_by", { direction, amount, selector }))
);

server.tool(
  "browser_get_scroll_position",
  "Get the current scroll position, page dimensions, and whether at top/bottom — useful for knowing if there is more content to scroll to",
  {
    selector: z
      .string()
      .optional()
      .describe("CSS selector of a scrollable container (defaults to the page)"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("get_scroll_position", { selector }))
);

// ============================================================
// Shared OS-level helpers
// ============================================================

const CLICLICK_PATH = "/opt/homebrew/bin/cliclick";

async function execAsync(cmd, timeoutMs = 10000) {
  const { exec } = await import("child_process");
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

async function cliclickCmd(action, timeoutMs = 5000) {
  return execAsync(`${CLICLICK_PATH} ${action}`, timeoutMs);
}

// --- Screenshot ---

async function getChromeWindowInfo() {
  const { execSync } = await import("child_process");
  try {
    const result = execSync(`swift -e '
import CoreGraphics
if let windowList = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] {
    for window in windowList {
        let owner = window["kCGWindowOwnerName"] as? String ?? ""
        let wid = window["kCGWindowNumber"] as? Int ?? 0
        let layer = window["kCGWindowLayer"] as? Int ?? -1
        if owner.contains("Chrome") && layer == 0 {
            let bounds = window["kCGWindowBounds"] as? [String: Any] ?? [:]
            let x = bounds["X"] as? Double ?? 0
            let y = bounds["Y"] as? Double ?? 0
            let w = bounds["Width"] as? Double ?? 0
            let h = bounds["Height"] as? Double ?? 0
            print("\\(wid),\\(x),\\(y),\\(w),\\(h)")
            break
        }
    }
}
'`, { timeout: 5000 }).toString().trim();
    if (!result) return null;
    const parts = result.split(",");
    if (parts.length < 5) return { id: parts[0], x: 0, y: 0, width: 0, height: 0 };
    return {
      id: parts[0],
      x: parseFloat(parts[1]),
      y: parseFloat(parts[2]),
      width: parseFloat(parts[3]),
      height: parseFloat(parts[4]),
    };
  } catch { return null; }
}

async function osScreenshot() {
  const { readFileSync, unlinkSync } = await import("fs");
  const tmpFile = `/tmp/mcp-screenshot-${Date.now()}.png`;

  const info = await getChromeWindowInfo();
  const captureCmd = info
    ? `screencapture -x -o -l ${info.id} ${tmpFile}`
    : `osascript -e 'tell application "Google Chrome" to activate' && sleep 0.5 && screencapture -x ${tmpFile}`;

  try {
    await execAsync(captureCmd, 10000);
    const data = readFileSync(tmpFile).toString("base64");
    try { unlinkSync(tmpFile); } catch {}
    return { content: [{ type: "image", data, mimeType: "image/png" }] };
  } catch (e) {
    try { unlinkSync(tmpFile); } catch {}
    return { content: [{ type: "text", text: `OS screenshot failed: ${e.message}` }], isError: true };
  }
}

server.tool(
  "browser_screenshot",
  "Take a screenshot of the visible area of the active tab. Automatically falls back to OS-level screen capture on restricted pages (Chrome Web Store, chrome:// URLs).",
  {},
  async () => {
    try {
      const result = await sendCommand("take_screenshot");
      if (result && result.success) return formatScreenshot(result);
      return await osScreenshot();
    } catch {
      return await osScreenshot();
    }
  }
);

// ============================================================
// OS-level interaction tools (for restricted pages)
// These use AppleScript, Swift, cliclick, and Chrome's
// AppleScript JS bridge to bypass extension API restrictions
// on chrome://* and chrome.google.com/webstore/* pages.
// ============================================================

async function chromeAppleScriptJs(code) {
  const escaped = code.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    const result = await execAsync(
      `osascript -e 'tell application "Google Chrome" to execute front window'"'"'s active tab javascript "${escaped}"'`,
      15000
    );
    return { success: true, data: result.trim() };
  } catch (e) {
    const msg = e.message || "";
    if (msg.includes("not allowed") || msg.includes("turned off") || msg.includes("AppleEvent")) {
      return {
        success: false,
        error: "JavaScript from Apple Events is disabled. Enable it in Chrome: View > Developer > Allow JavaScript from Apple Events",
      };
    }
    return { success: false, error: msg };
  }
}

async function getChromeToolbarHeight() {
  const toolbarResult = await chromeAppleScriptJs(`window.outerHeight - window.innerHeight`);
  if (toolbarResult.success) {
    const h = parseInt(toolbarResult.data, 10);
    if (h > 0 && h < 300) return h;
  }
  return 88;
}

// --- browser_os_screenshot ---

server.tool(
  "browser_os_screenshot",
  "Take an OS-level screenshot of Chrome's front window using CGWindowID capture. Works on ANY page including chrome:// and Chrome Web Store. More reliable than the extension-based screenshot for restricted pages.",
  {},
  async () => {
    const { readFileSync, unlinkSync } = await import("fs");
    const tmpFile = `/tmp/mcp-os-screenshot-${Date.now()}.png`;
    const info = await getChromeWindowInfo();
    if (!info) {
      return { content: [{ type: "text", text: "Could not find Chrome window. Is Chrome running?" }], isError: true };
    }
    try {
      await execAsync(`screencapture -x -o -l ${info.id} ${tmpFile}`);
      const data = readFileSync(tmpFile).toString("base64");
      try { unlinkSync(tmpFile); } catch {}
      return { content: [{ type: "image", data, mimeType: "image/png" }] };
    } catch (e) {
      try { unlinkSync(tmpFile); } catch {}
      return { content: [{ type: "text", text: `OS screenshot failed: ${e.message}` }], isError: true };
    }
  }
);

// --- browser_os_click ---

server.tool(
  "browser_os_click",
  "Click at a position in Chrome's window using cliclick for reliable OS-level clicking. Accepts x/y as percentages (0-100) of the window dimensions so you don't need absolute screen coordinates. Use browser_os_screenshot first to see the page layout. Works on restricted pages (Chrome Web Store, chrome:// URLs).",
  {
    x: z.number().describe("X position as percentage (0-100) of window width, or absolute pixels if useAbsolute is true"),
    y: z.number().describe("Y position as percentage (0-100) of window height, or absolute pixels if useAbsolute is true"),
    useAbsolute: z.boolean().optional().describe("If true, treat x/y as absolute screen coordinates instead of percentages (default false)"),
  },
  async ({ x, y, useAbsolute }) => {
    const info = await getChromeWindowInfo();
    if (!info && !useAbsolute) {
      return { content: [{ type: "text", text: "Could not find Chrome window. Is Chrome running?" }], isError: true };
    }

    let absX, absY;
    if (useAbsolute) {
      absX = Math.round(x);
      absY = Math.round(y);
    } else {
      absX = Math.round(info.x + (x / 100) * info.width);
      absY = Math.round(info.y + (y / 100) * info.height);
    }

    try {
      await execAsync(`osascript -e 'tell application "Google Chrome" to activate'`);
      await new Promise((r) => setTimeout(r, 200));
      await cliclickCmd(`c:${absX},${absY}`);
      return {
        content: [{
          type: "text",
          text: `Clicked at (${absX}, ${absY})` + (useAbsolute ? "" : ` [${x.toFixed(1)}%, ${y.toFixed(1)}% of ${info.width}x${info.height} window at ${info.x},${info.y}]`),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `OS click failed: ${e.message}` }], isError: true };
    }
  }
);

// --- browser_os_double_click ---

server.tool(
  "browser_os_double_click",
  "Double-click at a position in Chrome's window using cliclick. Accepts x/y as percentages (0-100) of window dimensions or absolute pixels. Useful for selecting words, opening items, etc. Works on restricted pages.",
  {
    x: z.number().describe("X position as percentage (0-100) of window width, or absolute pixels if useAbsolute is true"),
    y: z.number().describe("Y position as percentage (0-100) of window height, or absolute pixels if useAbsolute is true"),
    useAbsolute: z.boolean().optional().describe("If true, treat x/y as absolute screen coordinates instead of percentages (default false)"),
  },
  async ({ x, y, useAbsolute }) => {
    const info = await getChromeWindowInfo();
    if (!info && !useAbsolute) {
      return { content: [{ type: "text", text: "Could not find Chrome window. Is Chrome running?" }], isError: true };
    }

    let absX, absY;
    if (useAbsolute) {
      absX = Math.round(x);
      absY = Math.round(y);
    } else {
      absX = Math.round(info.x + (x / 100) * info.width);
      absY = Math.round(info.y + (y / 100) * info.height);
    }

    try {
      await execAsync(`osascript -e 'tell application "Google Chrome" to activate'`);
      await new Promise((r) => setTimeout(r, 200));
      await cliclickCmd(`dc:${absX},${absY}`);
      return {
        content: [{
          type: "text",
          text: `Double-clicked at (${absX}, ${absY})` + (useAbsolute ? "" : ` [${x.toFixed(1)}%, ${y.toFixed(1)}% of ${info.width}x${info.height} window at ${info.x},${info.y}]`),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `OS double-click failed: ${e.message}` }], isError: true };
    }
  }
);

// --- browser_os_focus ---

server.tool(
  "browser_os_focus",
  "Activate and bring Chrome to the foreground. Call before other OS operations to ensure Chrome is the focused application.",
  {},
  async () => {
    try {
      await execAsync(`osascript -e 'tell application "Google Chrome" to activate'`);
      await new Promise((r) => setTimeout(r, 300));
      return { content: [{ type: "text", text: "Chrome activated and focused" }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Failed to focus Chrome: ${e.message}` }], isError: true };
    }
  }
);

// --- browser_os_scroll ---

server.tool(
  "browser_os_scroll",
  "Scroll on the active Chrome page using OS-level scroll events. Works on restricted pages. Scrolls at the current mouse position or at specified coordinates.",
  {
    direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
    amount: z.number().optional().describe("Number of scroll steps (default 5, each step is roughly one notch of a scroll wheel)"),
    x: z.number().optional().describe("X position as percentage (0-100) of window width to scroll at (default: center)"),
    y: z.number().optional().describe("Y position as percentage (0-100) of window height to scroll at (default: center)"),
  },
  async ({ direction, amount, x, y }) => {
    const steps = amount || 5;
    const info = await getChromeWindowInfo();
    if (!info) {
      return { content: [{ type: "text", text: "Could not find Chrome window. Is Chrome running?" }], isError: true };
    }

    const posX = Math.round(info.x + ((x ?? 50) / 100) * info.width);
    const posY = Math.round(info.y + ((y ?? 50) / 100) * info.height);

    try {
      await execAsync(`osascript -e 'tell application "Google Chrome" to activate'`);
      await new Promise((r) => setTimeout(r, 200));

      const scrollJs = direction === "up" || direction === "down"
        ? `window.scrollBy(0, ${direction === "down" ? steps * 100 : -steps * 100})`
        : `window.scrollBy(${direction === "right" ? steps * 100 : -steps * 100}, 0)`;

      const jsResult = await chromeAppleScriptJs(scrollJs);
      if (!jsResult.success) {
        const keyCode = direction === "down" ? 125 : direction === "up" ? 126 : direction === "right" ? 124 : 123;
        const keyCommands = Array(steps).fill(`key code ${keyCode}`).join("\n");
        await execAsync(`osascript -e '
tell application "System Events"
  ${keyCommands}
end tell'`);
      }

      return { content: [{ type: "text", text: `Scrolled ${direction} ${steps} steps at (${posX}, ${posY})` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `OS scroll failed: ${e.message}` }], isError: true };
    }
  }
);

// --- browser_os_type ---

server.tool(
  "browser_os_type",
  "Type text using OS-level keyboard simulation. Works on restricted pages where the extension cannot script.",
  {
    text: z.string().describe("Text to type"),
    pressEnter: z.boolean().optional().describe("Press Enter after typing (default false)"),
  },
  async ({ text, pressEnter }) => {
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const enterCmd = pressEnter ? ` && osascript -e 'tell application "System Events" to key code 36'` : "";
    try {
      await execAsync(
        `osascript -e 'tell application "Google Chrome" to activate' && sleep 0.2 && osascript -e 'tell application "System Events" to keystroke "${escaped}"'${enterCmd}`
      );
      return { content: [{ type: "text", text: `Typed "${text}"${pressEnter ? " + Enter" : ""}` }] };
    } catch (e) {
      return { content: [{ type: "text", text: `OS type failed: ${e.message}` }], isError: true };
    }
  }
);

// --- browser_os_js ---

server.tool(
  "browser_os_js",
  "Execute JavaScript on the active Chrome tab via AppleScript bridge. Bypasses ALL extension restrictions — works on chrome://, Chrome Web Store, and any other page. Requires 'Allow JavaScript from Apple Events' to be enabled in Chrome (View > Developer menu).",
  {
    code: z.string().describe("JavaScript code to execute in the page context. Must return a value (use JSON.stringify for objects)."),
  },
  async ({ code }) => {
    const result = await chromeAppleScriptJs(code);
    if (result.success) {
      return { content: [{ type: "text", text: result.data || "(no return value)" }] };
    }
    return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
  }
);

// --- browser_os_dom_query ---

server.tool(
  "browser_os_dom_query",
  "Query the DOM on the active tab using a CSS selector, via the AppleScript JS bridge. Returns element info (tag, text, attributes, bounding rect, visibility) for all matching elements. Works on restricted pages.",
  {
    selector: z.string().describe("CSS selector to query"),
    limit: z.number().optional().describe("Max elements to return (default 20)"),
  },
  async ({ selector, limit }) => {
    const maxResults = limit || 20;
    const escaped = selector.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
    const js = `(function() {
      var els = document.querySelectorAll('${escaped}');
      var results = [];
      for (var i = 0; i < Math.min(els.length, ${maxResults}); i++) {
        var el = els[i];
        var rect = el.getBoundingClientRect();
        var attrs = {};
        for (var a = 0; a < el.attributes.length; a++) {
          attrs[el.attributes[a].name] = el.attributes[a].value;
        }
        results.push({
          index: i,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').substring(0, 200),
          attributes: attrs,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          visible: rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== 'hidden'
        });
      }
      return JSON.stringify({ total: els.length, results: results });
    })()`;

    const result = await chromeAppleScriptJs(js);
    if (result.success) {
      return { content: [{ type: "text", text: result.data }] };
    }
    return { content: [{ type: "text", text: `Error: ${result.error}` }], isError: true };
  }
);

// --- browser_os_accept_agreement ---

server.tool(
  "browser_os_accept_agreement",
  "Find and click checkboxes or agreement buttons on the current page. Uses AppleScript JS bridge to locate elements and cliclick for reliable clicking. Searches for input[type=checkbox] and buttons/links matching a text pattern. Works on restricted pages.",
  {
    textPattern: z.string().optional().describe("Text pattern to match in buttons/labels (default: matches common agreement terms like 'agree', 'accept', 'terms')"),
    clickCheckboxes: z.boolean().optional().describe("Also click any unchecked checkboxes (default true)"),
  },
  async ({ textPattern, clickCheckboxes }) => {
    const shouldClickCheckboxes = clickCheckboxes !== false;
    const pattern = textPattern || "agree|accept|terms|i have read|acknowledge|consent|confirm";
    const escapedPattern = pattern.replace(/'/g, "\\'").replace(/\\/g, "\\\\");

    const js = `(function() {
      var targets = [];
      ${shouldClickCheckboxes ? `
      var checkboxes = document.querySelectorAll('input[type="checkbox"]:not(:checked)');
      for (var i = 0; i < checkboxes.length; i++) {
        var rect = checkboxes[i].getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          var label = checkboxes[i].labels && checkboxes[i].labels[0] ? checkboxes[i].labels[0].innerText.substring(0, 100) : 'checkbox ' + i;
          targets.push({ type: 'checkbox', label: label, cx: rect.x + rect.width/2, cy: rect.y + rect.height/2 });
        }
      }
      ` : ''}
      var pattern = new RegExp('${escapedPattern}', 'i');
      var clickables = document.querySelectorAll('button, a, [role="button"], [type="submit"]');
      for (var j = 0; j < clickables.length; j++) {
        var text = (clickables[j].innerText || clickables[j].value || '').substring(0, 200);
        if (pattern.test(text)) {
          var rect = clickables[j].getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            targets.push({ type: 'button', label: text.substring(0, 100), cx: rect.x + rect.width/2, cy: rect.y + rect.height/2 });
          }
        }
      }
      return JSON.stringify({ targets: targets });
    })()`;

    const jsResult = await chromeAppleScriptJs(js);
    if (!jsResult.success) {
      return { content: [{ type: "text", text: `Error: ${jsResult.error}` }], isError: true };
    }

    let parsed;
    try { parsed = JSON.parse(jsResult.data); } catch {
      return { content: [{ type: "text", text: `Failed to parse element data: ${jsResult.data}` }], isError: true };
    }

    if (!parsed.targets || parsed.targets.length === 0) {
      return { content: [{ type: "text", text: "No matching agreement elements found on the page" }] };
    }

    const info = await getChromeWindowInfo();
    if (!info) {
      return { content: [{ type: "text", text: "Could not find Chrome window" }], isError: true };
    }

    const chromeUiHeight = await getChromeToolbarHeight();
    const actions = [];

    await execAsync(`osascript -e 'tell application "Google Chrome" to activate'`);
    await new Promise((r) => setTimeout(r, 300));

    for (const target of parsed.targets) {
      const absX = Math.round(info.x + target.cx);
      const absY = Math.round(info.y + chromeUiHeight + target.cy);
      try {
        await cliclickCmd(`c:${absX},${absY}`);
        actions.push(`${target.type === 'checkbox' ? 'checked' : 'clicked'}: ${target.label} at (${absX}, ${absY})`);
        await new Promise((r) => setTimeout(r, 200));
      } catch (e) {
        actions.push(`failed ${target.type}: ${target.label} — ${e.message}`);
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ actions, count: actions.length }, null, 2) }] };
  }
);

// --- browser_os_find_and_click ---

server.tool(
  "browser_os_find_and_click",
  "Find an element by text content or CSS selector on the active tab and click it using cliclick for reliable OS-level mouse clicking. Uses the AppleScript JS bridge to locate the element's bounding rect, then cliclick to click the center. Works on restricted pages.",
  {
    selector: z.string().optional().describe("CSS selector to find the element"),
    text: z.string().optional().describe("Text content to search for (case-insensitive, finds the first visible match)"),
    doubleClick: z.boolean().optional().describe("Double-click instead of single click (default false)"),
  },
  async ({ selector, text, doubleClick }) => {
    if (!selector && !text) {
      return { content: [{ type: "text", text: "Provide either selector or text to find the element" }], isError: true };
    }

    const escapedSelector = (selector || "").replace(/'/g, "\\'").replace(/\\/g, "\\\\");
    const escapedText = (text || "").replace(/'/g, "\\'").replace(/\\/g, "\\\\");

    const js = `(function() {
      var el = null;
      ${selector ? `el = document.querySelector('${escapedSelector}');` : ""}
      ${text && !selector ? `
      var pattern = new RegExp('${escapedText}', 'i');
      var all = document.querySelectorAll('button, a, span, div, p, label, input, [role="button"], [role="link"], [role="tab"], [role="menuitem"]');
      for (var i = 0; i < all.length; i++) {
        var t = (all[i].innerText || all[i].value || '').trim();
        if (pattern.test(t) && all[i].getBoundingClientRect().width > 0) {
          el = all[i];
          break;
        }
      }` : ""}
      if (!el) return JSON.stringify({ found: false });
      var rect = el.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        viewportCenterX: rect.x + rect.width / 2,
        viewportCenterY: rect.y + rect.height / 2,
        text: (el.innerText || '').substring(0, 100),
        tag: el.tagName.toLowerCase()
      });
    })()`;

    const jsResult = await chromeAppleScriptJs(js);
    if (!jsResult.success) {
      return { content: [{ type: "text", text: `Error finding element: ${jsResult.error}` }], isError: true };
    }

    let parsed;
    try { parsed = JSON.parse(jsResult.data); } catch {
      return { content: [{ type: "text", text: `Failed to parse element location: ${jsResult.data}` }], isError: true };
    }

    if (!parsed.found) {
      return { content: [{ type: "text", text: `Element not found${selector ? ` for selector: ${selector}` : ""}${text ? ` with text: ${text}` : ""}` }], isError: true };
    }

    const info = await getChromeWindowInfo();
    if (!info) {
      return { content: [{ type: "text", text: "Could not find Chrome window to calculate click position" }], isError: true };
    }

    const chromeUiHeight = await getChromeToolbarHeight();
    const absX = Math.round(info.x + parsed.viewportCenterX);
    const absY = Math.round(info.y + chromeUiHeight + parsed.viewportCenterY);

    try {
      await execAsync(`osascript -e 'tell application "Google Chrome" to activate'`);
      await new Promise((r) => setTimeout(r, 200));
      const clickAction = doubleClick ? `dc:${absX},${absY}` : `c:${absX},${absY}`;
      await cliclickCmd(clickAction);
      return {
        content: [{
          type: "text",
          text: `Found <${parsed.tag}> "${parsed.text}" and ${doubleClick ? "double-" : ""}clicked at (${absX}, ${absY})`,
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Found element but click failed: ${e.message}` }], isError: true };
    }
  }
);

// --- File upload ---

server.tool(
  "browser_upload_file",
  "Upload file(s) to a file input element using absolute local paths",
  {
    selector: z
      .string()
      .describe("CSS selector for the <input type=file> element"),
    filePaths: z
      .union([z.string(), z.array(z.string())])
      .describe(
        "Absolute path(s) to local file(s), e.g. /Users/ross/Downloads/resume.pdf"
      ),
  },
  async ({ selector, filePaths }) =>
    formatResult(await sendCommand("upload_file", { selector, filePaths }))
);

// --- Close dialogs/modals/popups ---

server.tool(
  "browser_close_dialogs",
  "Close open modals, dialogs, popups, and overlays on the page. Tries Escape key, close buttons, overlay clicks, and HTML dialog elements. Use when UI elements are blocking interaction.",
  {
    strategy: z
      .enum(["escape", "buttons", "overlays", "dialogs"])
      .optional()
      .describe("Specific close strategy (omit to try all)"),
  },
  async ({ strategy }) =>
    formatResult(await sendCommand("close_dialogs", { strategy }))
);

// --- Keyboard ---

server.tool(
  "browser_press_key",
  "Press a keyboard key on the active tab, optionally with modifiers (ctrl, shift, alt, meta) and targeting a specific element",
  {
    key: z.string().describe("Key to press (e.g. 'Enter', 'Tab', 'Escape', 'a', 'ArrowDown')"),
    modifiers: z
      .object({
        ctrl: z.boolean().optional(),
        shift: z.boolean().optional(),
        alt: z.boolean().optional(),
        meta: z.boolean().optional(),
      })
      .optional()
      .describe("Modifier keys to hold"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector for element to target (defaults to focused element)"),
  },
  async ({ key, modifiers, selector }) =>
    formatResult(await sendCommand("press_key", { key, modifiers, selector }))
);

// --- Hover ---

server.tool(
  "browser_hover",
  "Hover over an element on the active tab (triggers mouseenter/mouseover events, useful for tooltips and hover menus)",
  {
    selector: z.string().describe("CSS selector for the element to hover"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("hover_element", { selector }))
);

// --- Element inspection ---

server.tool(
  "browser_get_element_attributes",
  "Get all attributes, bounding rect, visibility, and text content of an element",
  {
    selector: z.string().describe("CSS selector for the element to inspect"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("get_element_attributes", { selector }))
);

server.tool(
  "browser_find_elements",
  "Find elements by CSS selector and/or text content, returning their details (tag, id, class, text, visibility)",
  {
    selector: z.string().optional().describe("CSS selector to match"),
    text: z.string().optional().describe("Text content to search for (case-insensitive)"),
    limit: z.number().optional().describe("Max results to return (default 20)"),
  },
  async ({ selector, text, limit }) =>
    formatResult(await sendCommand("find_elements", { selector, text, limit }))
);

// --- Navigation: back/forward ---

server.tool(
  "browser_go_back",
  "Navigate the active tab back in history (like clicking the back button)",
  {},
  async () => formatResult(await sendCommand("go_back"))
);

server.tool(
  "browser_go_forward",
  "Navigate the active tab forward in history (like clicking the forward button)",
  {},
  async () => formatResult(await sendCommand("go_forward"))
);

// --- Tab management: new/close ---

server.tool(
  "browser_new_tab",
  "Open a new browser tab, optionally with a URL",
  {
    url: z.string().optional().describe("URL to open (defaults to blank tab)"),
  },
  async ({ url }) =>
    formatResult(await sendCommand("new_tab", { url }))
);

server.tool(
  "browser_close_tab",
  "Close a browser tab by ID, or close the active tab if no ID given",
  {
    tabId: z.number().optional().describe("Tab ID to close (defaults to active tab)"),
  },
  async ({ tabId }) =>
    formatResult(await sendCommand("close_tab", { tabId }))
);

// --- Viewport ---

server.tool(
  "browser_set_viewport",
  "Resize the browser window to specific dimensions",
  {
    width: z.number().describe("Window width in pixels"),
    height: z.number().describe("Window height in pixels"),
  },
  async ({ width, height }) =>
    formatResult(await sendCommand("set_viewport", { width, height }))
);

// --- Visual debugging: highlights and annotations ---

server.tool(
  "browser_highlight_element",
  "Highlight an element on the page with a colored border and semi-transparent overlay. Useful for visual debugging before taking a screenshot — highlights what the AI is looking at.",
  {
    selector: z.string().describe("CSS selector for the element to highlight"),
    color: z.string().regex(/^#[0-9a-fA-F]{3,8}$/).optional().describe("Border/overlay color as hex (default '#ff0000' red)"),
    label: z.string().optional().describe("Optional label text shown in the top-left corner of the highlight"),
  },
  async ({ selector, color, label }) =>
    formatResult(await sendCommand("highlight_element", { selector, color, label }))
);

server.tool(
  "browser_highlight_all",
  "Highlight all elements matching a CSS selector with auto-cycling colors and index labels. Great for visualizing lists, grids, or multiple matches at once.",
  {
    selector: z.string().describe("CSS selector matching multiple elements"),
    colors: z.array(z.string().regex(/^#[0-9a-fA-F]{3,8}$/)).optional().describe("Custom color palette as hex array (default cycles through red, green, blue, magenta, yellow)"),
  },
  async ({ selector, colors }) =>
    formatResult(await sendCommand("highlight_all", { selector, colors }))
);

server.tool(
  "browser_clear_highlights",
  "Remove all highlight overlays and annotations from the page. Call this to clean up after visual debugging.",
  {},
  async () =>
    formatResult(await sendCommand("clear_highlights"))
);

server.tool(
  "browser_annotate_element",
  "Add a tooltip-style text annotation near an element. The annotation appears as a dark tooltip with custom text, positioned relative to the element.",
  {
    selector: z.string().describe("CSS selector for the element to annotate"),
    text: z.string().describe("Annotation text to display"),
    position: z.enum(["top", "bottom", "left", "right"]).optional().describe("Where to place the annotation relative to the element (default 'top')"),
  },
  async ({ selector, text, position }) =>
    formatResult(await sendCommand("annotate_element", { selector, text, position }))
);

// --- Cookie management ---

server.tool(
  "browser_get_cookies",
  "Get all cookies for the current tab's URL. Returns an array of cookie objects with name, value, domain, path, expiration, and flags.",
  {},
  async () => formatResult(await sendCommand("get_cookies"))
);

server.tool(
  "browser_get_cookie",
  "Get a specific cookie by name for the current tab's URL",
  {
    name: z.string().describe("The name of the cookie to retrieve"),
  },
  async ({ name }) =>
    formatResult(await sendCommand("get_cookie", { name }))
);

server.tool(
  "browser_set_cookie",
  "Set a cookie with full options. Uses the active tab's URL if no URL is provided.",
  {
    name: z.string().describe("Cookie name"),
    value: z.string().describe("Cookie value"),
    url: z.string().optional().describe("URL to associate the cookie with (defaults to active tab URL)"),
    domain: z.string().optional().describe("Cookie domain (e.g. '.example.com')"),
    path: z.string().optional().describe("Cookie path (default '/')"),
    expirationDate: z.number().optional().describe("Expiration as Unix timestamp in seconds (omit for session cookie)"),
    httpOnly: z.boolean().optional().describe("Whether the cookie is HTTP-only (default false)"),
    secure: z.boolean().optional().describe("Whether the cookie requires HTTPS (default false)"),
    sameSite: z.enum(["no_restriction", "lax", "strict"]).optional().describe("SameSite attribute"),
  },
  async ({ name, value, url, domain, path, expirationDate, httpOnly, secure, sameSite }) =>
    formatResult(await sendCommand("set_cookie", { name, value, url, domain, path, expirationDate, httpOnly, secure, sameSite }))
);

server.tool(
  "browser_delete_cookie",
  "Delete a specific cookie by name. Uses the active tab's URL if no URL is provided.",
  {
    name: z.string().describe("Name of the cookie to delete"),
    url: z.string().optional().describe("URL of the cookie (defaults to active tab URL)"),
  },
  async ({ name, url }) =>
    formatResult(await sendCommand("delete_cookie", { name, url }))
);

server.tool(
  "browser_clear_cookies",
  "Clear all cookies for a domain, or for the current tab's URL if no domain is specified",
  {
    domain: z.string().optional().describe("Domain to clear cookies for (defaults to active tab's domain)"),
  },
  async ({ domain }) =>
    formatResult(await sendCommand("clear_cookies", { domain }))
);

// --- Clipboard ---

server.tool(
  "browser_read_clipboard",
  "Read text content from the system clipboard via the active browser tab",
  {},
  async () => formatResult(await sendCommand("read_clipboard"))
);

server.tool(
  "browser_write_clipboard",
  "Write text to the system clipboard via the active browser tab",
  {
    text: z.string().describe("The text to write to the clipboard"),
  },
  async ({ text }) =>
    formatResult(await sendCommand("write_clipboard", { text }))
);

server.tool(
  "browser_read_clipboard_html",
  "Read clipboard contents as HTML if available, with fallback to plain text. Returns the HTML markup, available MIME types, and plain text fallback.",
  {},
  async () => formatResult(await sendCommand("read_clipboard_html"))
);

// --- Extension management ---

server.tool(
  "browser_status",
  "Check whether the MCP server is running and the Chrome extension is connected (does NOT require the extension to be connected)",
  {},
  async () => {
    const connected = !!(extensionSocket && extensionSocket.readyState === 1);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server: "running",
            wsPort: WS_PORT,
            extensionConnected: connected,
            extensionId: extensionId || null,
            pendingRequests: pendingRequests.size,
          }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "browser_wait_for_extension",
  "Wait for the Chrome extension to connect to the MCP server (use after reload or when extension is disconnected)",
  {
    timeoutMs: z.number().optional().describe("Max wait time in ms (default 15000)"),
  },
  async ({ timeoutMs }) => {
    const timeout = timeoutMs || 15000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (extensionSocket && extensionSocket.readyState === 1) {
        return {
          content: [{ type: "text", text: "Extension connected" }],
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return {
      content: [{ type: "text", text: `Extension did not connect within ${timeout}ms` }],
      isError: true,
    };
  }
);

server.tool(
  "browser_reload_extension",
  "Reload the browser control Chrome extension to pick up code changes, then wait for it to reconnect",
  {
    waitForReconnect: z.boolean().optional().describe("Wait for extension to reconnect after reload (default true)"),
    timeoutMs: z.number().optional().describe("Max time to wait for reconnect in ms (default 10000)"),
  },
  async ({ waitForReconnect, timeoutMs }) => {
    const shouldWait = waitForReconnect !== false;
    const timeout = timeoutMs || 10000;

    try {
      await sendCommand("reload_extension", {}, 2000);
    } catch {}

    if (!shouldWait) {
      return {
        content: [{ type: "text", text: "Extension reloading (not waiting for reconnect)" }],
      };
    }

    await new Promise((r) => setTimeout(r, 1000));

    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (extensionSocket && extensionSocket.readyState === 1) {
        return {
          content: [{ type: "text", text: "Extension reloaded and reconnected" }],
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    return {
      content: [{ type: "text", text: `Extension reloaded but did not reconnect within ${timeout}ms. Check chrome://extensions for errors.` }],
      isError: true,
    };
  }
);

server.tool(
  "browser_open_extensions_page",
  "Open chrome://extensions in Chrome so the user can check/enable the extension (use when extension is disconnected and needs manual intervention)",
  {},
  async () => {
    const { exec } = await import("child_process");
    return new Promise((resolve) => {
      exec('open -a "Google Chrome" "chrome://extensions"', (err) => {
        if (err) {
          resolve({
            content: [{ type: "text", text: `Failed to open extensions page: ${err.message}` }],
            isError: true,
          });
        } else {
          resolve({
            content: [{ type: "text", text: "Opened chrome://extensions — check that 'Claude Code Browser Control' is enabled and has no errors" }],
          });
        }
      });
    });
  }
);

server.tool(
  "browser_recover_extension",
  "Automatically recover the Chrome extension when disconnected. Enables AppleScript JS via defaults, restarts Chrome (restores all tabs), and waits for reconnection. Does NOT require the extension to be connected.",
  {},
  async () => {
    const { exec } = await import("child_process");
    const execAsync = (cmd) => new Promise((resolve, reject) => {
      exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout.trim()));
    });

    const steps = [];

    try {
      // Step 1: Enable AppleScript JS in Chrome's preferences
      await execAsync('defaults write com.google.Chrome AppleScriptEnabled -bool true');
      steps.push("defaults:written");

      // Step 2: Restart Chrome via chrome://restart (restores all tabs)
      await execAsync('open -a "Google Chrome" "chrome://restart"');
      steps.push("restart:triggered");

      // Step 3: Wait for Chrome to come back and extension to reconnect
      await new Promise((r) => setTimeout(r, 5000));

      const start = Date.now();
      while (Date.now() - start < 20000) {
        if (extensionSocket && extensionSocket.readyState === 1) {
          return { content: [{ type: "text", text: `Extension recovered and reconnected [${steps.join(", ")}] (id: ${extensionId})` }] };
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      return {
        content: [{ type: "text", text: `Chrome restarted but extension did not reconnect within 20s. Steps: [${steps.join(", ")}]` }],
        isError: true,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `Recovery failed at [${steps.join(", ")}]: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// --- Network monitoring ---

server.tool(
  "browser_get_network_requests",
  "Monitor network requests on the active tab for a duration. Captures all HTTP requests with URL, method, status, type, size, and timing information. WARNING: This blocks all other browser commands for the entire monitoring duration — no clicks, navigation, or other actions will be processed until monitoring completes.",
  {
    durationMs: z
      .number()
      .optional()
      .describe("How long to capture requests in ms (default 5000)"),
  },
  async ({ durationMs }) =>
    formatResult(
      await sendCommand(
        "get_network_requests",
        { durationMs },
        (durationMs || 5000) + 5000
      )
    )
);

server.tool(
  "browser_wait_for_network_request",
  "Wait for a network request matching a URL pattern (substring match). Returns the matched request with status, headers, and timing.",
  {
    urlPattern: z
      .string()
      .describe("URL substring to match against (e.g. '/api/users' or 'graphql')"),
    timeoutMs: z
      .number()
      .optional()
      .describe("Max wait time in ms (default 15000)"),
  },
  async ({ urlPattern, timeoutMs }) =>
    formatResult(
      await sendCommand(
        "wait_for_network_request",
        { urlPattern, timeoutMs },
        (timeoutMs || 15000) + 5000
      )
    )
);


// --- Audio playback ---

server.tool(
  "browser_play_tone",
  "Play musical tones through the browser's Web Audio API. Notes can be frequencies in Hz (e.g. 440) or note names like 'C4', 'E5', 'F#3', 'Bb4'. Use 'rest' for silence. Great for audio notifications, debugging feedback, or playing melodies.",
  {
    notes: z.array(z.object({
      note: z.union([z.number(), z.string()]).describe("Frequency in Hz (e.g. 440) or note name ('C4', 'E5', 'F#3') or 'rest' for silence"),
      duration: z.number().optional().describe("Duration in seconds (default 0.2). With tempo set, this is beat fraction (1=quarter note, 0.5=eighth)"),
    })).describe("Sequence of notes to play"),
    waveform: z.enum(["sine", "triangle", "square", "sawtooth"]).optional().describe("Oscillator waveform (default 'triangle')"),
    volume: z.number().min(0).max(1).optional().describe("Volume 0-1 (default 0.3)"),
    tempo: z.number().optional().describe("Tempo in BPM — when set, note durations become beat fractions (1=quarter note at this BPM)"),
  },
  async ({ notes, waveform, volume, tempo }) =>
    formatResult(await sendCommand("play_tone", { notes, waveform, volume, tempo }))
);

// --- Structured data extraction ---

server.tool(
  "browser_extract_table",
  "Extract an HTML table as structured JSON with headers and row arrays. Useful for reading data tables, pricing grids, comparison charts, leaderboards, etc.",
  {
    selector: z.string().optional().describe("CSS selector for the table element (default: first <table> on page)"),
    includeHeaders: z.boolean().optional().describe("Extract the header row (default true)"),
  },
  async ({ selector, includeHeaders }) =>
    formatResult(await sendCommand("extract_table", { selector, includeHeaders }))
);

server.tool(
  "browser_get_links",
  "Get all links (<a> elements) on the page or within a container, with their href, text, title, rel, and visibility",
  {
    selector: z.string().optional().describe("CSS selector for container to scope the search (default: entire page)"),
    includeHidden: z.boolean().optional().describe("Include links that are not visible (default false)"),
  },
  async ({ selector, includeHidden }) =>
    formatResult(await sendCommand("get_links", { selector, includeHidden }))
);

server.tool(
  "browser_get_metadata",
  "Get comprehensive page metadata: title, charset, lang, all <meta> tags, Open Graph, Twitter Card, JSON-LD structured data, canonical URL, and favicon",
  {},
  async () => formatResult(await sendCommand("get_metadata"))
);

server.tool(
  "browser_query_selector_all",
  "Query all elements matching a CSS selector and extract their text, attributes, visibility, and bounding rects. More flexible than browser_find_elements — specify exactly which attributes to extract.",
  {
    selector: z.string().describe("CSS selector to match"),
    attributes: z.array(z.string()).optional().describe("Specific attribute names to extract (default: all attributes)"),
    limit: z.number().optional().describe("Max elements to return (default 50)"),
  },
  async ({ selector, attributes, limit }) =>
    formatResult(await sendCommand("query_selector_all", { selector, attributes, limit }))
);

// --- Browser storage ---

server.tool(
  "browser_get_storage",
  "Read from localStorage or sessionStorage. Returns a single value by key, or all key-value pairs if no key is specified.",
  {
    type: z.enum(["local", "session"]).optional().describe("Storage type (default 'local')"),
    key: z.string().optional().describe("Specific key to retrieve (omit to get all items)"),
  },
  async ({ type, key }) =>
    formatResult(await sendCommand("get_storage", { storageType: type, key }))
);

server.tool(
  "browser_set_storage",
  "Write a value to localStorage or sessionStorage",
  {
    type: z.enum(["local", "session"]).optional().describe("Storage type (default 'local')"),
    key: z.string().describe("Storage key"),
    value: z.string().describe("Value to store (must be a string — JSON.stringify objects first)"),
  },
  async ({ type, key, value }) =>
    formatResult(await sendCommand("set_storage", { storageType: type, key, value }))
);

server.tool(
  "browser_remove_storage",
  "Remove a key from localStorage or sessionStorage",
  {
    type: z.enum(["local", "session"]).optional().describe("Storage type (default 'local')"),
    key: z.string().describe("Key to remove"),
  },
  async ({ type, key }) =>
    formatResult(await sendCommand("remove_storage", { storageType: type, key }))
);

server.tool(
  "browser_clear_storage",
  "Clear all items from localStorage or sessionStorage",
  {
    type: z.enum(["local", "session"]).optional().describe("Storage type (default 'local')"),
  },
  async ({ type }) =>
    formatResult(await sendCommand("clear_storage", { storageType: type }))
);

// --- Iframe interaction ---

server.tool(
  "browser_list_frames",
  "List all frames and iframes on the active tab with their frameId, URL, and parent-child relationships. Use the returned frameId values in other browser_frame_* tools.",
  {},
  async () => formatResult(await sendCommand("list_frames"))
);

server.tool(
  "browser_frame_content",
  "Get text content from inside a specific iframe. Use browser_list_frames first to discover available frameIds.",
  {
    frameId: z.number().describe("Frame ID from browser_list_frames"),
    selector: z.string().optional().describe("CSS selector within the iframe (default: entire body)"),
  },
  async ({ frameId, selector }) =>
    formatResult(await sendCommand("frame_content", { frameId, selector }))
);

server.tool(
  "browser_frame_click",
  "Click an element inside an iframe (auto-scrolls into view first)",
  {
    frameId: z.number().describe("Frame ID from browser_list_frames"),
    selector: z.string().describe("CSS selector for the element within the iframe"),
  },
  async ({ frameId, selector }) =>
    formatResult(await sendCommand("frame_click", { frameId, selector }))
);

server.tool(
  "browser_frame_fill",
  "Fill a form field inside an iframe (React-compatible). Same behavior as browser_fill_field but targeting a specific frame.",
  {
    frameId: z.number().describe("Frame ID from browser_list_frames"),
    selector: z.string().describe("CSS selector for the input/textarea in the iframe"),
    value: z.string().describe("Text value to fill in"),
  },
  async ({ frameId, selector, value }) =>
    formatResult(await sendCommand("frame_fill", { frameId, selector, value }))
);

server.tool(
  "browser_frame_execute_js",
  "Execute JavaScript inside a specific iframe's page context. Use for advanced iframe interaction not covered by other frame tools.",
  {
    frameId: z.number().describe("Frame ID from browser_list_frames"),
    code: z.string().describe("JavaScript code to execute in the iframe context"),
  },
  async ({ frameId, code }) =>
    formatResult(await sendCommand("frame_execute_js", { frameId, code }))
);

// --- Google OAuth automation ---

server.tool(
  "google_oauth_select_account",
  "Select a Google account on the account chooser page. If the account is listed, clicks it. If not, clicks 'Use another account' and enters the email. Returns what page we landed on after selection (e.g., password entry, consent, 2FA).",
  {
    email: z.string().describe("The Google account email to select"),
  },
  async ({ email }) =>
    formatResult(await sendCommand("google_oauth_select_account", { email }, 20000))
);

server.tool(
  "google_oauth_consent",
  "Handle a Google OAuth consent/authorization screen by clicking Allow/Continue or Cancel. Detects if the current page is a consent screen and clicks the appropriate button.",
  {
    action: z
      .enum(["allow", "cancel"])
      .optional()
      .describe("Whether to allow or cancel the consent (default: 'allow')"),
  },
  async ({ action }) =>
    formatResult(await sendCommand("google_oauth_consent", { action }, 15000))
);

server.tool(
  "google_oauth_flow",
  "High-level Google OAuth flow orchestrator. Automatically detects the current step of a Google sign-in flow and handles it: selects account, grants consent, and reports when manual steps are needed (password entry, 2FA). Does NOT store or accept passwords — returns { needs_password: true } when a password is required.",
  {
    email: z.string().describe("The Google account email to authenticate with"),
    timeout_ms: z
      .number()
      .optional()
      .describe("Max time in ms to attempt the flow (default: 30000)"),
  },
  async ({ email, timeout_ms }) =>
    formatResult(
      await sendCommand(
        "google_oauth_flow",
        { email, timeoutMs: timeout_ms },
        (timeout_ms || 30000) + 5000
      )
    )
);

// --- Credential / password handling ---

function execSecurity(args) {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/security", args, { timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

server.tool(
  "browser_fill_password",
  "Fill a password field on the active tab (React-compatible). Same behavior as browser_fill_field but semantically for password/credential fields.",
  {
    selector: z.string().describe("CSS selector for the password input element"),
    password: z.string().describe("The password value to fill in"),
  },
  async ({ selector, password }) =>
    formatResult(await sendCommand("fill_password", { selector, password }))
);

server.tool(
  "credential_store",
  "Store credentials securely in the macOS Keychain",
  {
    service: z.string().describe("Service name / domain (e.g. 'google.com')"),
    username: z.string().describe("Account username or email"),
    password: z.string().describe("Password to store"),
  },
  async ({ service, username, password }) => {
    try {
      await execSecurity([
        "add-generic-password",
        "-a", username,
        "-s", service,
        "-w", password,
        "-U",
      ]);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: `Credentials stored for ${username} @ ${service}` }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Failed to store credentials` }], isError: true };
    }
  }
);

server.tool(
  "credential_retrieve",
  "Retrieve credentials from the macOS Keychain",
  {
    service: z.string().describe("Service name / domain (e.g. 'google.com')"),
    username: z.string().optional().describe("Account username or email (if omitted, returns first match for the service)"),
  },
  async ({ service, username }) => {
    try {
      const args = ["find-generic-password", "-s", service];
      if (username) args.push("-a", username);
      args.push("-w");
      const password = await execSecurity(args);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, password }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Credential not found for service '${service}'` }], isError: true };
    }
  }
);

server.tool(
  "credential_delete",
  "Delete credentials from the macOS Keychain",
  {
    service: z.string().describe("Service name / domain (e.g. 'google.com')"),
    username: z.string().describe("Account username or email"),
  },
  async ({ service, username }) => {
    try {
      await execSecurity([
        "delete-generic-password",
        "-s", service,
        "-a", username,
      ]);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: `Credentials deleted for ${username} @ ${service}` }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Failed to delete credentials` }], isError: true };
    }
  }
);

server.tool(
  "browser_auto_login",
  "Retrieve credentials from macOS Keychain and automatically fill a login form on the active tab",
  {
    service: z.string().describe("Service name / domain used as the Keychain lookup key"),
    username_selector: z.string().optional().describe("CSS selector for the username/email field (if present on page)"),
    password_selector: z.string().describe("CSS selector for the password field"),
    submit_selector: z.string().optional().describe("CSS selector for the submit/login button (if omitted, form is filled but not submitted)"),
  },
  async ({ service, username_selector, password_selector, submit_selector }) => {
    // Step 1: Retrieve credentials from Keychain
    let username, password;
    try {
      const infoArgs = ["find-generic-password", "-s", service, "-g"];
      // -g outputs to stderr; we need to capture it via a different approach
      const info = await new Promise((resolve, reject) => {
        execFile("/usr/bin/security", infoArgs, { timeout: 10000 }, (err, stdout, stderr) => {
          // -g returns the password on stderr and attributes on stdout
          // The command exits 0 if found, non-zero if not
          if (err && !stderr) {
            reject(new Error("Credential not found"));
          } else {
            resolve(stderr + "\n" + stdout);
          }
        });
      });
      const acctMatch = info.match(/"acct"<blob>="([^"]*)"/);
      username = acctMatch ? acctMatch[1] : undefined;
    } catch {
      // Fall through — we'll still try to get the password
    }

    try {
      const args = ["find-generic-password", "-s", service, "-w"];
      password = await execSecurity(args);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: No credentials found in Keychain for service '${service}'` }], isError: true };
    }

    const actions = [];

    // Step 2: Fill username if selector provided and we have a username
    if (username_selector && username) {
      try {
        const usernameResult = await sendCommand("fill_field", { selector: username_selector, value: username });
        if (usernameResult.success) {
          actions.push(`Filled username in ${username_selector}`);
        } else {
          actions.push(`Failed to fill username: ${usernameResult.error}`);
        }
      } catch (e) {
        actions.push(`Failed to fill username: ${e.message}`);
      }
    } else if (username_selector && !username) {
      actions.push("Username selector provided but no username found in Keychain entry");
    }

    // Step 3: Fill password
    try {
      const passwordResult = await sendCommand("fill_password", { selector: password_selector, password });
      if (passwordResult.success) {
        actions.push(`Filled password in ${password_selector}`);
      } else {
        return { content: [{ type: "text", text: `Error: Failed to fill password: ${passwordResult.error}` }], isError: true };
      }
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Failed to fill password: ${e.message}` }], isError: true };
    }

    // Step 4: Click submit if selector provided
    if (submit_selector) {
      try {
        const clickResult = await sendCommand("click_element", { selector: submit_selector });
        if (clickResult.success) {
          actions.push(`Clicked submit button ${submit_selector}`);
        } else {
          actions.push(`Failed to click submit: ${clickResult.error}`);
        }
      } catch (e) {
        actions.push(`Failed to click submit: ${e.message}`);
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ success: true, data: actions.join("; ") }) }] };
  }
);

// ── Managed Auth Flows ──

// Helper: generate a secure password (uppercase, lowercase, digits, symbols)
function generateSecurePassword(length = 20) {
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const symbols = "!@#$%^&*()-_=+[]{}|;:,.<>?";
  const all = upper + lower + digits + symbols;

  const bytes = randomBytes(length + 4);
  let password = "";
  // Guarantee at least one of each category
  password += upper[bytes[0] % upper.length];
  password += lower[bytes[1] % lower.length];
  password += digits[bytes[2] % digits.length];
  password += symbols[bytes[3] % symbols.length];

  for (let i = 4; i < length; i++) {
    password += all[bytes[i] % all.length];
  }

  // Shuffle using Fisher-Yates
  const arr = password.split("");
  const shuffleBytes = randomBytes(arr.length);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join("");
}

// Helper: TOTP generation (RFC 6238, SHA-1, 6 digits, 30-second window)
function base32Decode(encoded) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const cleanInput = encoded.replace(/[\s=-]+/g, "").toUpperCase();
  let bits = "";
  for (let i = 0; i < cleanInput.length; i++) {
    const val = alphabet.indexOf(cleanInput[i]);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, "0");
  }
  const byteArr = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    byteArr.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(byteArr);
}

function generateTOTP(secret, timeStep = 30, digits = 6) {
  const key = base32Decode(secret);
  const epoch = Math.floor(Date.now() / 1000);
  const counter = Math.floor(epoch / timeStep);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuf.writeUInt32BE(counter & 0xffffffff, 4);
  const hmac = createHmac("sha1", key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % Math.pow(10, digits);
  const remaining = timeStep - (epoch % timeStep);
  return { code: code.toString().padStart(digits, "0"), remaining_seconds: remaining };
}

server.tool(
  "login_detect",
  "Analyze the current page to detect if it is a login/sign-in page. Returns detected password fields, username fields, OAuth/social login buttons (Google, GitHub, Apple, etc.), submit buttons, signup links, CAPTCHA presence, remember-me checkboxes, and error messages.",
  {},
  async () => formatResult(await sendCommand("login_detect", {}, 15000))
);

server.tool(
  "login_flow",
  "Full managed login orchestrator. Detects the login form, optionally uses OAuth, or retrieves credentials from macOS Keychain to fill and submit the form. Returns success/failure with actionable status.",
  {
    service: z.string().describe("Keychain service name for credential lookup (e.g. 'github.com')"),
    prefer_oauth: z.string().optional().describe("Prefer this OAuth provider if available: 'google', 'github', 'apple', etc."),
    email: z.string().optional().describe("Email for OAuth account selection"),
  },
  async ({ service, prefer_oauth, email }) => {
    const timeoutMs = 30000;

    // Step 1: Detect the login page
    let detection;
    try {
      detection = await sendCommand("login_detect", {}, 15000);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message }) }] };
    }
    if (!detection.success) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: detection.error }) }] };
    }
    const page = detection.data;

    if (!page.is_login_page) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "not_login_page", detected: page }) }] };
    }

    if (page.has_captcha) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_captcha", detected_fields: page }) }] };
    }

    // Step 2: If prefer_oauth is set and that provider exists, use OAuth
    if (prefer_oauth && page.has_oauth.includes(prefer_oauth.toLowerCase())) {
      // Click the OAuth button
      try {
        const oauthClickResult = await sendCommand("find_elements", { text: prefer_oauth, limit: 5 }, 10000);
        if (oauthClickResult.success && oauthClickResult.data?.elements?.length > 0) {
          // Find the OAuth button among results
          for (const el of oauthClickResult.data.elements) {
            if (el.selector) {
              await sendCommand("click_element", { selector: el.selector }, 5000);
              break;
            }
          }
        }
      } catch (e) {
        // Fall through to credential-based login
      }

      // Wait for navigation
      await new Promise(r => setTimeout(r, 2000));

      // If Google OAuth, use the dedicated flow
      if (prefer_oauth.toLowerCase() === "google" && email) {
        try {
          const oauthResult = await sendCommand("google_oauth_flow", { email, timeoutMs: timeoutMs - 5000 }, timeoutMs);
          if (oauthResult.success) {
            return { content: [{ type: "text", text: JSON.stringify({ success: true, method: "google_oauth", ...oauthResult.data }) }] };
          }
        } catch (e) {
          // Fall through
        }
      }

      // Check if we landed somewhere post-OAuth
      try {
        const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
        if (tabInfo.success) {
          return { content: [{ type: "text", text: JSON.stringify({ success: true, method: "oauth_" + prefer_oauth, logged_in_url: tabInfo.data.url }) }] };
        }
      } catch (e) { /* fall through */ }
    }

    // Step 3: Credential-based login
    let username, password;
    try {
      const infoArgs = ["find-generic-password", "-s", service, "-g"];
      const info = await new Promise((resolve, reject) => {
        execFile("/usr/bin/security", infoArgs, { timeout: 10000 }, (err, stdout, stderr) => {
          if (err && !stderr) reject(new Error("Credential not found"));
          else resolve(stderr + "\n" + stdout);
        });
      });
      const acctMatch = info.match(/"acct"<blob>="([^"]*)"/);
      username = acctMatch ? acctMatch[1] : undefined;
    } catch (e) { /* no username found */ }

    try {
      password = await execSecurity(["find-generic-password", "-s", service, "-w"]);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_credentials", message: "No credentials found in Keychain for service '" + service + "'", detected_fields: page }) }] };
    }

    const actions = [];

    // Fill username
    if (page.username_selector && username) {
      try {
        const r = await sendCommand("fill_field", { selector: page.username_selector, value: username }, 5000);
        if (r.success) actions.push("filled_username");
        else actions.push("username_fill_failed: " + r.error);
      } catch (e) { actions.push("username_fill_error: " + e.message); }
    }

    // Fill password
    if (page.password_selector && password) {
      try {
        const r = await sendCommand("fill_password", { selector: page.password_selector, password }, 5000);
        if (r.success) actions.push("filled_password");
        else return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "fill_failed", message: r.error }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "fill_failed", message: e.message }) }] };
      }
    } else if (!page.password_selector) {
      // Multi-step login: might need to enter username first, then click next
      if (page.submit_selector) {
        try {
          await sendCommand("click_element", { selector: page.submit_selector }, 5000);
          actions.push("clicked_next_for_password_step");
          await new Promise(r => setTimeout(r, 2000));

          // Re-detect for password field
          const redetect = await sendCommand("login_detect", {}, 10000);
          if (redetect.success && redetect.data.password_selector) {
            const r = await sendCommand("fill_password", { selector: redetect.data.password_selector, password }, 5000);
            if (r.success) actions.push("filled_password_step2");
            page.submit_selector = redetect.data.submit_selector;
          }
        } catch (e) { actions.push("multi_step_error: " + e.message); }
      }
    }

    // Click submit
    if (page.submit_selector) {
      try {
        const r = await sendCommand("click_element", { selector: page.submit_selector }, 5000);
        if (r.success) actions.push("clicked_submit");
      } catch (e) { actions.push("submit_error: " + e.message); }
    }

    // Wait for navigation and check result
    await new Promise(r => setTimeout(r, 3000));

    // Check if we're still on the login page
    let postDetection;
    try {
      postDetection = await sendCommand("login_detect", {}, 10000);
    } catch (e) { /* ignore */ }

    const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
    const resultUrl = tabInfo.success ? tabInfo.data.url : "unknown";

    if (postDetection?.success && postDetection.data.is_login_page) {
      // Still on login page = failure
      const errorMsg = postDetection.data.error_message;
      if (errorMsg && /password|credential|invalid|incorrect|wrong/i.test(errorMsg)) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "invalid_credentials", error_message: errorMsg, actions }) }] };
      }
      // Check for 2FA
      if (postDetection.data.has_password_field === false && !postDetection.data.username_selector) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_2fa", actions, url: resultUrl }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "still_on_login_page", error_message: errorMsg || null, actions }) }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ success: true, logged_in_url: resultUrl, actions }) }] };
  }
);

server.tool(
  "signup_flow",
  "Detect registration form fields and fill them (name, email, password). Generates a secure password if requested. Stores credentials in Keychain. Does NOT submit the form — returns what was filled for review.",
  {
    service: z.string().describe("Keychain service name to store credentials under"),
    email: z.string().describe("Email address for registration"),
    name: z.string().optional().describe("Full name (or first + last if form has separate fields)"),
    generate_password: z.boolean().optional().describe("Generate a secure 20-char password (default true)"),
  },
  async ({ service, email, name, generate_password }) => {
    const shouldGenerate = generate_password !== false;

    // Step 1: Detect signup form
    let detection;
    try {
      detection = await sendCommand("signup_detect", {}, 15000);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message }) }] };
    }
    if (!detection.success) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: detection.error }) }] };
    }
    const fields = detection.data;

    if (fields.has_captcha) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_captcha", detected_fields: fields }) }] };
    }

    const filledFields = [];

    // Step 2: Fill name fields
    if (name) {
      if (fields.name_selector) {
        try {
          await sendCommand("fill_field", { selector: fields.name_selector, value: name }, 5000);
          filledFields.push("name");
        } catch (e) { /* skip */ }
      } else if (fields.first_name_selector) {
        const parts = name.split(/\s+/);
        const firstName = parts[0];
        const lastName = parts.slice(1).join(" ");
        try {
          await sendCommand("fill_field", { selector: fields.first_name_selector, value: firstName }, 5000);
          filledFields.push("first_name");
        } catch (e) { /* skip */ }
        if (lastName && fields.last_name_selector) {
          try {
            await sendCommand("fill_field", { selector: fields.last_name_selector, value: lastName }, 5000);
            filledFields.push("last_name");
          } catch (e) { /* skip */ }
        }
      }
    }

    // Step 3: Fill email
    if (fields.email_selector) {
      try {
        await sendCommand("fill_field", { selector: fields.email_selector, value: email }, 5000);
        filledFields.push("email");
      } catch (e) { /* skip */ }
    }

    // Step 4: Fill username if separate from email
    if (fields.username_selector && fields.username_selector !== fields.email_selector) {
      try {
        await sendCommand("fill_field", { selector: fields.username_selector, value: email }, 5000);
        filledFields.push("username");
      } catch (e) { /* skip */ }
    }

    // Step 5: Generate and fill password
    let generatedPassword = null;
    if (shouldGenerate && fields.password_selector) {
      // randomBytes imported at top level
      const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = "abcdefghijklmnopqrstuvwxyz";
      const digs = "0123456789";
      const syms = "!@#$%^&*()-_=+[]{}|;:,.<>?";
      const all = upper + lower + digs + syms;
      const bytes = randomBytes(24);
      let pw = "";
      pw += upper[bytes[0] % upper.length];
      pw += lower[bytes[1] % lower.length];
      pw += digs[bytes[2] % digs.length];
      pw += syms[bytes[3] % syms.length];
      for (let i = 4; i < 20; i++) pw += all[bytes[i] % all.length];
      const arr = pw.split("");
      const shuf = randomBytes(arr.length);
      for (let i = arr.length - 1; i > 0; i--) { const j = shuf[i] % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      generatedPassword = arr.join("");

      try {
        await sendCommand("fill_password", { selector: fields.password_selector, password: generatedPassword }, 5000);
        filledFields.push("password");
      } catch (e) { /* skip */ }

      // Fill confirm password
      if (fields.confirm_password_selector) {
        try {
          await sendCommand("fill_password", { selector: fields.confirm_password_selector, password: generatedPassword }, 5000);
          filledFields.push("confirm_password");
        } catch (e) { /* skip */ }
      }
    }

    // Step 6: Store credentials in Keychain
    let passwordStored = false;
    if (generatedPassword) {
      try {
        await execSecurity(["add-generic-password", "-a", email, "-s", service, "-w", generatedPassword, "-U"]);
        passwordStored = true;
      } catch (e) { /* keychain store failed */ }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          fields_filled: filledFields,
          password_stored: passwordStored,
          has_terms_checkbox: fields.has_terms_checkbox,
          has_captcha: fields.has_captcha,
          status: "ready_to_submit",
        }),
      }],
    };
  }
);

server.tool(
  "password_reset_flow",
  "Find and click the 'Forgot password' link on the current page, wait for the reset form to load, fill in the email, and submit the reset request.",
  {
    email: z.string().describe("Email address for the password reset"),
  },
  async ({ email }) => {
    // Step 1: Find the reset link
    let resetDetection;
    try {
      resetDetection = await sendCommand("password_reset_detect", {}, 10000);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message }) }] };
    }
    if (!resetDetection.success || !resetDetection.data.has_reset_link) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_reset_link", message: "No 'forgot password' or 'reset password' link found on this page" }) }] };
    }

    // Step 2: Click the reset link
    const selector = resetDetection.data.reset_link_selector;
    if (selector) {
      try {
        await sendCommand("click_element", { selector }, 5000);
      } catch (e) {
        // Try finding by text as fallback
        try {
          await sendCommand("find_elements", { text: resetDetection.data.reset_link_text, limit: 1 }, 5000);
        } catch (e2) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "click_failed", message: e.message }) }] };
        }
      }
    }

    // Step 3: Wait for reset page to load
    await new Promise(r => setTimeout(r, 3000));

    // Step 4: Find and fill the email field
    let emailFilled = false;
    const emailSelectors = [
      'input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]',
      'input#email', 'input[name="username"]', 'input[name="login"]',
    ];
    for (const sel of emailSelectors) {
      try {
        const r = await sendCommand("fill_field", { selector: sel, value: email }, 3000);
        if (r.success) { emailFilled = true; break; }
      } catch (e) { continue; }
    }

    if (!emailFilled) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_email_field", message: "Could not find email field on reset page" }) }] };
    }

    // Step 5: Click submit
    let submitted = false;
    const submitSelectors = ['button[type="submit"]', 'input[type="submit"]'];
    for (const sel of submitSelectors) {
      try {
        const r = await sendCommand("click_element", { selector: sel }, 3000);
        if (r.success) { submitted = true; break; }
      } catch (e) { continue; }
    }

    if (!submitted) {
      // Try finding submit by text
      const submitTexts = ["reset", "send", "submit", "continue", "next"];
      for (const text of submitTexts) {
        try {
          const found = await sendCommand("find_elements", { text, limit: 3 }, 5000);
          if (found.success && found.data?.elements?.length > 0) {
            for (const el of found.data.elements) {
              if (el.tag === "button" || el.tag === "a" || el.tag === "input") {
                if (el.selector) {
                  await sendCommand("click_element", { selector: el.selector }, 3000);
                  submitted = true;
                  break;
                }
              }
            }
            if (submitted) break;
          }
        } catch (e) { continue; }
      }
    }

    await new Promise(r => setTimeout(r, 2000));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          status: "reset_email_sent",
          email,
          submitted,
          next_step: "check_email",
        }),
      }],
    };
  }
);

server.tool(
  "password_change",
  "Detect a password change form, retrieve current password from Keychain, generate or use a new password, fill all fields, and update Keychain. Does NOT submit — returns for review.",
  {
    service: z.string().describe("Keychain service name to retrieve/update credentials"),
    new_password: z.string().optional().describe("New password to use (generates a secure 20-char password if omitted)"),
  },
  async ({ service, new_password }) => {
    // Step 1: Detect the password change form
    let detection;
    try {
      detection = await sendCommand("password_change_detect", {}, 10000);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message }) }] };
    }
    if (!detection.success || !detection.data.is_change_form) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "not_change_form", message: "No password change form detected on this page" }) }] };
    }
    const form = detection.data;

    // Step 2: Retrieve current password from Keychain
    let currentPassword, username;
    try {
      currentPassword = await execSecurity(["find-generic-password", "-s", service, "-w"]);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_current_password", message: "No current password found in Keychain for service '" + service + "'" }) }] };
    }

    // Get username for Keychain update
    try {
      const info = await new Promise((resolve, reject) => {
        execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-g"], { timeout: 10000 }, (err, stdout, stderr) => {
          if (err && !stderr) reject(err);
          else resolve(stderr + "\n" + stdout);
        });
      });
      const acctMatch = info.match(/"acct"<blob>="([^"]*)"/);
      username = acctMatch ? acctMatch[1] : service;
    } catch (e) { username = service; }

    // Step 3: Generate new password if not provided
    let newPassword = new_password;
    if (!newPassword) {
      // randomBytes imported at top level
      const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const lower = "abcdefghijklmnopqrstuvwxyz";
      const digs = "0123456789";
      const syms = "!@#$%^&*()-_=+[]{}|;:,.<>?";
      const all = upper + lower + digs + syms;
      const bytes = randomBytes(24);
      let pw = "";
      pw += upper[bytes[0] % upper.length];
      pw += lower[bytes[1] % lower.length];
      pw += digs[bytes[2] % digs.length];
      pw += syms[bytes[3] % syms.length];
      for (let i = 4; i < 20; i++) pw += all[bytes[i] % all.length];
      const arr = pw.split("");
      const shuf = randomBytes(arr.length);
      for (let i = arr.length - 1; i > 0; i--) { const j = shuf[i] % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
      newPassword = arr.join("");
    }

    const actions = [];

    // Step 4: Fill current password
    if (form.current_password_selector) {
      try {
        await sendCommand("fill_password", { selector: form.current_password_selector, password: currentPassword }, 5000);
        actions.push("filled_current_password");
      } catch (e) { actions.push("current_password_failed: " + e.message); }
    }

    // Step 5: Fill new password
    if (form.new_password_selector) {
      try {
        await sendCommand("fill_password", { selector: form.new_password_selector, password: newPassword }, 5000);
        actions.push("filled_new_password");
      } catch (e) { actions.push("new_password_failed: " + e.message); }
    }

    // Step 6: Fill confirm password
    if (form.confirm_password_selector) {
      try {
        await sendCommand("fill_password", { selector: form.confirm_password_selector, password: newPassword }, 5000);
        actions.push("filled_confirm_password");
      } catch (e) { actions.push("confirm_password_failed: " + e.message); }
    }

    // Step 7: Update Keychain
    let keychainUpdated = false;
    try {
      await execSecurity(["add-generic-password", "-a", username, "-s", service, "-w", newPassword, "-U"]);
      keychainUpdated = true;
    } catch (e) { /* keychain update failed */ }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          password_updated_in_keychain: keychainUpdated,
          actions,
          submit_selector: form.submit_selector,
          status: "ready_to_submit",
        }),
      }],
    };
  }
);

server.tool(
  "auth_detect",
  "Analyze the current page to detect what type of authentication is required: standard login form, OAuth/social login, SSO redirect, SAML, magic link, MFA challenge, etc. Returns all detected options.",
  {},
  async () => {
    // Combine login detection with OAuth and MFA detection
    let loginInfo, tabInfo;
    try {
      [loginInfo, tabInfo] = await Promise.all([
        sendCommand("login_detect", {}, 15000),
        sendCommand("get_active_tab_info", {}, 5000),
      ]);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message }) }] };
    }

    const url = tabInfo?.success ? tabInfo.data.url : "";
    const page = loginInfo?.success ? loginInfo.data : {};

    // Determine auth type
    const authTypes = [];
    if (page.has_password_field && page.username_selector) authTypes.push("credential_login");
    if (page.has_password_field && !page.username_selector) authTypes.push("password_only");
    if (page.has_oauth?.length > 0) authTypes.push("oauth");
    if (/saml|adfs|sso|okta|auth0|onelogin/i.test(url)) authTypes.push("sso");

    // Check for magic link patterns
    let hasMagicLink = false;
    try {
      const magicResult = await sendCommand("find_elements", { text: "magic link|email me a link|passwordless|sign in with email", limit: 3 }, 5000);
      if (magicResult.success && magicResult.data?.elements?.length > 0) {
        hasMagicLink = true;
        authTypes.push("magic_link");
      }
    } catch (e) { /* ignore */ }

    // Check for MFA
    let mfaInfo = null;
    try {
      const mfaDetect = await sendCommand("mfa_detect", {}, 10000);
      if (mfaDetect.success && mfaDetect.data.is_mfa_page) {
        mfaInfo = mfaDetect.data;
        authTypes.push("mfa_" + mfaDetect.data.mfa_type);
      }
    } catch (e) { /* ignore */ }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          data: {
            url,
            auth_types: authTypes,
            login: page,
            mfa: mfaInfo,
            has_magic_link: hasMagicLink,
            recommendation: authTypes.length === 0 ? "not_an_auth_page" :
              authTypes.includes("mfa_totp") ? "use_mfa_auto" :
              authTypes.includes("oauth") ? "use_login_flow_with_oauth" :
              authTypes.includes("credential_login") ? "use_login_flow" :
              authTypes[0],
          },
        }),
      }],
    };
  }
);

server.tool(
  "auth_flow",
  "Master authentication orchestrator. Detects the auth type on the current page and handles it end-to-end: tries OAuth if available, falls back to credential-based login, handles multi-step flows and MFA. Composes login_flow, google_oauth_flow, mfa_auto, and credential tools.",
  {
    service: z.string().describe("Keychain service name for credential/TOTP lookup"),
    email: z.string().optional().describe("Email address for OAuth or account selection"),
    prefer_oauth: z.string().optional().describe("Preferred OAuth provider: 'google', 'github', etc."),
    timeout_ms: z.number().optional().describe("Max time for the entire auth flow in ms (default 60000)"),
  },
  async ({ service, email, prefer_oauth, timeout_ms }) => {
    const timeout = timeout_ms || 60000;
    const start = Date.now();
    const actions = [];

    while (Date.now() - start < timeout) {
      // Detect current auth state
      let loginInfo, tabInfo;
      try {
        [loginInfo, tabInfo] = await Promise.all([
          sendCommand("login_detect", {}, 15000),
          sendCommand("get_active_tab_info", {}, 5000),
        ]);
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message, actions }) }] };
      }

      const url = tabInfo?.success ? tabInfo.data.url : "";
      const page = loginInfo?.success ? loginInfo.data : {};

      // Check for MFA page first
      let mfaInfo = null;
      try {
        const mfaDetect = await sendCommand("mfa_detect", {}, 10000);
        if (mfaDetect.success && mfaDetect.data.is_mfa_page) mfaInfo = mfaDetect.data;
      } catch (e) { /* ignore */ }

      if (mfaInfo) {
        if (mfaInfo.mfa_type === "totp") {
          // Try auto TOTP
          try {
            const totpSecret = await execSecurity(["find-generic-password", "-s", service + "-totp", "-w"]);
            const { code } = generateTOTP(totpSecret);
            if (mfaInfo.code_input_selector) {
              await sendCommand("fill_field", { selector: mfaInfo.code_input_selector, value: code }, 5000);
              actions.push({ step: "mfa_totp_filled", code_entered: true });
              if (mfaInfo.submit_selector) {
                await sendCommand("click_element", { selector: mfaInfo.submit_selector }, 5000);
                actions.push({ step: "mfa_submitted" });
              }
              await new Promise(r => setTimeout(r, 3000));
              continue; // Re-check state
            }
          } catch (e) {
            return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_manual_mfa", mfa_type: "totp", message: "TOTP secret not found in Keychain for '" + service + "-totp'", actions }) }] };
          }
        } else {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_manual_mfa", mfa_type: mfaInfo.mfa_type, message: "Manual " + mfaInfo.mfa_type + " verification required", actions }) }] };
        }
      }

      // Not an auth page anymore? We succeeded
      if (!page.is_login_page && actions.length > 0) {
        return { content: [{ type: "text", text: JSON.stringify({ success: true, logged_in_url: url, actions }) }] };
      }

      // Is this a Google OAuth page?
      if (/accounts\.google\.com/.test(url) && email) {
        try {
          const oauthResult = await sendCommand("google_oauth_flow", { email, timeoutMs: Math.min(30000, timeout - (Date.now() - start)) }, 35000);
          if (oauthResult.success) {
            actions.push({ step: "google_oauth", result: oauthResult.data });
            if (oauthResult.data?.needs_password) {
              // Get password from keychain for Google
              try {
                const pw = await execSecurity(["find-generic-password", "-s", service, "-w"]);
                await sendCommand("fill_password", { selector: 'input[type="password"]', password: pw }, 5000);
                actions.push({ step: "google_password_filled" });
                // Click next
                try {
                  await sendCommand("click_element", { selector: "#passwordNext button, #passwordNext" }, 5000);
                } catch (e) { /* try submit */ }
                await new Promise(r => setTimeout(r, 3000));
                continue;
              } catch (e) {
                return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_password", message: "Google account needs password but none found in Keychain", actions }) }] };
              }
            }
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
        } catch (e) { /* fall through */ }
      }

      // Standard login page
      if (page.is_login_page) {
        if (page.has_captcha) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_captcha", actions }) }] };
        }

        // Try OAuth first if preferred
        if (prefer_oauth && page.has_oauth?.includes(prefer_oauth.toLowerCase())) {
          try {
            // Use execute_js to find and click the OAuth button reliably
            const clickJs = `(function() {
              var providers = {${prefer_oauth}: /${prefer_oauth}/i};
              var els = document.querySelectorAll('button, a, [role="button"], [data-provider]');
              for (var i = 0; i < els.length; i++) {
                var t = ((els[i].innerText||'')+(els[i].className||'')+(els[i].id||'')+(els[i].getAttribute('data-provider')||'')).toLowerCase();
                if (/${prefer_oauth.toLowerCase()}/i.test(t)) { els[i].click(); return true; }
              }
              return false;
            })()`;
            await sendCommand("execute_js", { code: clickJs }, 5000);
            actions.push({ step: "oauth_button_clicked", provider: prefer_oauth });
            await new Promise(r => setTimeout(r, 3000));
            continue;
          } catch (e) { /* fall through to credentials */ }
        }

        // Credential-based login
        let password;
        try {
          password = await execSecurity(["find-generic-password", "-s", service, "-w"]);
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_credentials", message: "No credentials in Keychain for '" + service + "'", detected_fields: page, actions }) }] };
        }

        let username;
        try {
          const info = await new Promise((resolve, reject) => {
            execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-g"], { timeout: 10000 }, (err, stdout, stderr) => {
              if (err && !stderr) reject(err); else resolve(stderr + "\n" + stdout);
            });
          });
          const acctMatch = info.match(/"acct"<blob>="([^"]*)"/);
          username = acctMatch ? acctMatch[1] : email;
        } catch (e) { username = email; }

        if (page.username_selector && username) {
          try {
            await sendCommand("fill_field", { selector: page.username_selector, value: username }, 5000);
            actions.push({ step: "filled_username" });
          } catch (e) { /* skip */ }
        }

        if (page.password_selector) {
          try {
            await sendCommand("fill_password", { selector: page.password_selector, password }, 5000);
            actions.push({ step: "filled_password" });
          } catch (e) { /* skip */ }
        } else if (page.submit_selector) {
          // Multi-step: click next first
          await sendCommand("click_element", { selector: page.submit_selector }, 5000);
          actions.push({ step: "clicked_next_multistep" });
          await new Promise(r => setTimeout(r, 2500));
          continue;
        }

        if (page.submit_selector) {
          try {
            await sendCommand("click_element", { selector: page.submit_selector }, 5000);
            actions.push({ step: "clicked_submit" });
          } catch (e) { /* skip */ }
        }

        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      // Not a login page and no actions taken yet — not an auth page
      if (actions.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "not_auth_page", url, message: "Current page is not an authentication page" }) }] };
      }

      // Wait and re-check
      await new Promise(r => setTimeout(r, 2000));
    }

    return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "timeout", actions }) }] };
  }
);

server.tool(
  "mfa_detect",
  "Detect if the current page is an MFA/2FA challenge. Identifies the type: TOTP (authenticator app), SMS code, email code, push notification, security key, or backup codes. Returns the code input selector and submit button.",
  {},
  async () => formatResult(await sendCommand("mfa_detect", {}, 15000))
);

server.tool(
  "mfa_enter_code",
  "Fill in a TOTP/SMS/email verification code into the MFA input field and submit. Auto-detects the input field if no selector is provided.",
  {
    code: z.string().describe("The verification code to enter (e.g. '123456')"),
    selector: z.string().optional().describe("CSS selector for the code input field (auto-detects if omitted)"),
    submit: z.boolean().optional().describe("Whether to click submit after entering the code (default true)"),
  },
  async ({ code, selector, submit }) => {
    const shouldSubmit = submit !== false;

    // If no selector provided, detect the MFA input
    let codeSelector = selector;
    let submitSelector = null;
    if (!codeSelector) {
      try {
        const detection = await sendCommand("mfa_detect", {}, 10000);
        if (detection.success && detection.data.code_input_selector) {
          codeSelector = detection.data.code_input_selector;
          submitSelector = detection.data.submit_selector;
        }
      } catch (e) { /* ignore */ }
    }

    if (!codeSelector) {
      // Fallback: try common selectors
      const fallbacks = [
        'input[name="totp"]', 'input[name="code"]', 'input[name="otp"]',
        'input[name="verification_code"]', 'input[name="mfa_code"]',
        'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]',
        'input[type="tel"]', 'input[type="number"]',
      ];
      for (const sel of fallbacks) {
        try {
          const r = await sendCommand("fill_field", { selector: sel, value: code }, 3000);
          if (r.success) { codeSelector = sel; break; }
        } catch (e) { continue; }
      }
    }

    if (!codeSelector) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_code_field", message: "Could not find MFA code input field" }) }] };
    }

    // Fill the code
    try {
      const fillResult = await sendCommand("fill_field", { selector: codeSelector, value: code }, 5000);
      if (!fillResult.success) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "fill_failed", message: fillResult.error }) }] };
      }
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "fill_failed", message: e.message }) }] };
    }

    // Submit
    if (shouldSubmit) {
      if (!submitSelector) {
        submitSelector = 'button[type="submit"]';
      }
      try {
        await sendCommand("click_element", { selector: submitSelector }, 5000);
      } catch (e) {
        // Try pressing Enter
        try {
          await sendCommand("press_key", { key: "Enter", selector: codeSelector }, 3000);
        } catch (e2) { /* ignore */ }
      }
      await new Promise(r => setTimeout(r, 2000));
    }

    const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          code_entered: true,
          submitted: shouldSubmit,
          result_url: tabInfo.success ? tabInfo.data.url : "unknown",
        }),
      }],
    };
  }
);

server.tool(
  "mfa_totp_generate",
  "Generate a TOTP code from a secret stored in macOS Keychain. Retrieves the TOTP secret stored under the service name with '-totp' suffix. Uses RFC 6238 (30-second window, SHA-1, 6 digits).",
  {
    service: z.string().describe("Service name — the TOTP secret is looked up under '<service>-totp' in Keychain"),
  },
  async ({ service }) => {
    let secret;
    try {
      secret = await execSecurity(["find-generic-password", "-s", service + "-totp", "-w"]);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: No TOTP secret found in Keychain for '${service}-totp'` }], isError: true };
    }

    try {
      const result = generateTOTP(secret.trim());
      return { content: [{ type: "text", text: JSON.stringify({ success: true, ...result }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: TOTP generation failed: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "mfa_totp_store",
  "Store a TOTP secret in macOS Keychain under '<service>-totp'. The secret should be the base32-encoded string from the authenticator setup QR code or manual entry key.",
  {
    service: z.string().describe("Service name — stored under '<service>-totp' in Keychain"),
    secret: z.string().describe("Base32-encoded TOTP secret (e.g. 'JBSWY3DPEHPK3PXP')"),
  },
  async ({ service, secret }) => {
    try {
      await execSecurity(["add-generic-password", "-a", service, "-s", service + "-totp", "-w", secret.trim(), "-U"]);
      return { content: [{ type: "text", text: JSON.stringify({ success: true, data: `TOTP secret stored for ${service}` }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Failed to store TOTP secret` }], isError: true };
    }
  }
);

server.tool(
  "mfa_auto",
  "MFA orchestrator: detects MFA type, generates TOTP from Keychain if applicable and enters it, or returns a prompt for manual intervention (SMS, email, push, security key).",
  {
    service: z.string().describe("Keychain service name — TOTP secret looked up under '<service>-totp'"),
  },
  async ({ service }) => {
    // Step 1: Detect MFA type
    let detection;
    try {
      detection = await sendCommand("mfa_detect", {}, 15000);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message }) }] };
    }
    if (!detection.success || !detection.data.is_mfa_page) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "not_mfa_page", message: "Current page does not appear to be an MFA challenge" }) }] };
    }

    const mfa = detection.data;

    // Step 2: Handle by type
    if (mfa.mfa_type === "totp" || mfa.mfa_type === "code_entry") {
      // Try to generate TOTP from stored secret
      let secret;
      try {
        secret = await execSecurity(["find-generic-password", "-s", service + "-totp", "-w"]);
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_manual_code", mfa_type: mfa.mfa_type, message: "No TOTP secret found in Keychain for '" + service + "-totp'. Enter code manually using mfa_enter_code.", code_input_selector: mfa.code_input_selector }) }] };
      }

      const { code, remaining_seconds } = generateTOTP(secret.trim());

      // If less than 5 seconds remaining, wait for next window
      if (remaining_seconds < 5) {
        await new Promise(r => setTimeout(r, (remaining_seconds + 1) * 1000));
        const fresh = generateTOTP(secret.trim());
        return await enterMfaCode(fresh.code, mfa);
      }

      return await enterMfaCode(code, mfa);
    }

    // Non-TOTP types require manual intervention
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: false,
          reason: "needs_manual_mfa",
          mfa_type: mfa.mfa_type,
          message: `Manual ${mfa.mfa_type} verification required`,
          code_input_selector: mfa.code_input_selector,
        }),
      }],
    };

    // Helper to enter the code
    async function enterMfaCode(code, mfa) {
      if (mfa.code_input_selector) {
        try {
          await sendCommand("fill_field", { selector: mfa.code_input_selector, value: code }, 5000);
        } catch (e) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "fill_failed", message: e.message }) }] };
        }

        if (mfa.submit_selector) {
          try {
            await sendCommand("click_element", { selector: mfa.submit_selector }, 5000);
          } catch (e) {
            try { await sendCommand("press_key", { key: "Enter", selector: mfa.code_input_selector }, 3000); } catch (e2) { /* ignore */ }
          }
        }

        await new Promise(r => setTimeout(r, 3000));
        const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              mfa_type: "totp",
              code_entered: true,
              result_url: tabInfo.success ? tabInfo.data.url : "unknown",
            }),
          }],
        };
      }

      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_code_field", code, message: "TOTP code generated but no input field found" }) }] };
    }
  }
);

server.tool(
  "auth_sso_detect",
  "Detect SSO/SAML/OpenID Connect flows on the current page. Identifies the identity provider (Okta, Auth0, Azure AD, OneLogin, Google Workspace, etc.), the protocol (SAML, OIDC, OAuth2), and what redirect is happening.",
  {},
  async () => formatResult(await sendCommand("auth_sso_detect", {}, 15000))
);

server.tool(
  "auth_sso_flow",
  "Handle SSO/SAML redirects: follow redirect to the IdP, authenticate there using stored credentials, handle the callback redirect back to the service. Works with Okta, Auth0, Azure AD, OneLogin, and other common IdPs.",
  {
    service: z.string().describe("Keychain service name for credential lookup at the IdP"),
    email: z.string().optional().describe("Email/username for the IdP login"),
    timeout_ms: z.number().optional().describe("Max time for the entire SSO flow in ms (default 45000)"),
  },
  async ({ service, email, timeout_ms }) => {
    const timeout = timeout_ms || 45000;
    const start = Date.now();
    const actions = [];

    while (Date.now() - start < timeout) {
      // Detect SSO state
      let ssoInfo, tabInfo;
      try {
        [ssoInfo, tabInfo] = await Promise.all([
          sendCommand("auth_sso_detect", {}, 10000),
          sendCommand("get_active_tab_info", {}, 5000),
        ]);
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message, actions }) }] };
      }

      const url = tabInfo?.success ? tabInfo.data.url : "";
      const sso = ssoInfo?.success ? ssoInfo.data : {};

      // If no longer on SSO page and we took actions, we may be done
      if (!sso.is_sso_page && actions.length > 0) {
        // Check if we're back on the original service
        const sessionCheck = await sendCommand("auth_session_check", {}, 10000);
        if (sessionCheck?.success && sessionCheck.data.is_authenticated) {
          return { content: [{ type: "text", text: JSON.stringify({ success: true, logged_in_url: url, actions }) }] };
        }
        // Might still be redirecting
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      if (!sso.is_sso_page && actions.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "not_sso_page", url }) }] };
      }

      // Google Workspace SSO
      if (sso.provider === "google_workspace" || /accounts\.google\.com/.test(url)) {
        if (email) {
          try {
            const oauthResult = await sendCommand("google_oauth_flow", { email, timeoutMs: Math.min(25000, timeout - (Date.now() - start)) }, 30000);
            actions.push({ step: "google_sso", result: oauthResult?.data });
            if (oauthResult?.data?.needs_password) {
              try {
                const pw = await execSecurity(["find-generic-password", "-s", service, "-w"]);
                await sendCommand("fill_password", { selector: 'input[type="password"]', password: pw }, 5000);
                try { await sendCommand("click_element", { selector: "#passwordNext button, #passwordNext" }, 5000); } catch (e) { /* skip */ }
                actions.push({ step: "google_password_filled" });
                await new Promise(r => setTimeout(r, 3000));
                continue;
              } catch (e) {
                return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_password", actions }) }] };
              }
            }
            await new Promise(r => setTimeout(r, 2000));
            continue;
          } catch (e) { /* fall through */ }
        }
      }

      // Standard IdP login form
      if (sso.email_input_selector) {
        const loginEmail = email || (() => {
          try {
            const info = new Promise((resolve, reject) => {
              execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-g"], { timeout: 10000 }, (err, stdout, stderr) => {
                if (err && !stderr) reject(err); else resolve(stderr + "\n" + stdout);
              });
            });
            return info.then(i => { const m = i.match(/"acct"<blob>="([^"]*)"/); return m ? m[1] : null; });
          } catch (e) { return null; }
        })();

        if (loginEmail) {
          try {
            const resolvedEmail = await Promise.resolve(loginEmail);
            if (resolvedEmail) {
              await sendCommand("fill_field", { selector: sso.email_input_selector, value: resolvedEmail }, 5000);
              actions.push({ step: "filled_email", provider: sso.provider });
            }
          } catch (e) { /* skip */ }
        }

        // Fill password if visible
        const loginDetect = await sendCommand("login_detect", {}, 10000);
        if (loginDetect?.success && loginDetect.data.password_selector) {
          try {
            const pw = await execSecurity(["find-generic-password", "-s", service, "-w"]);
            await sendCommand("fill_password", { selector: loginDetect.data.password_selector, password: pw }, 5000);
            actions.push({ step: "filled_password", provider: sso.provider });
          } catch (e) {
            return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_credentials", provider: sso.provider, actions }) }] };
          }
        }

        // Click submit
        const submitSel = sso.submit_selector || loginDetect?.data?.submit_selector;
        if (submitSel) {
          try {
            await sendCommand("click_element", { selector: submitSel }, 5000);
            actions.push({ step: "clicked_submit" });
          } catch (e) { /* skip */ }
        }

        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      await new Promise(r => setTimeout(r, 2000));
    }

    return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "timeout", actions }) }] };
  }
);

server.tool(
  "auth_magic_link_flow",
  "Handle magic link / passwordless login flows: detect the 'check your email' state, search Gmail for the magic link email, click it, and handle the redirect back to the service.",
  {
    email: z.string().describe("Email address the magic link was sent to"),
    sender: z.string().optional().describe("Expected sender email or name for the magic link email"),
    link_pattern: z.string().optional().describe("Regex/substring to match in the magic link URL"),
    timeout_ms: z.number().optional().describe("Max time to wait for the email in ms (default 60000)"),
  },
  async ({ email, sender, link_pattern, timeout_ms }) => {
    const timeout = timeout_ms || 60000;

    // Use the existing email_verify_flow orchestrator with magic link patterns
    const senderQuery = sender || email.split("@")[1] || "";
    const pattern = link_pattern || "login|auth|magic|signin|verify|confirm|token";

    // Search Gmail for the magic link email
    const searchQuery = `from:${senderQuery} newer_than:10m`;
    const pollInterval = 5000;
    const start = Date.now();

    let searchResult;
    while (Date.now() - start < timeout) {
      try {
        searchResult = await sendCommand("gmail_search", { query: searchQuery, maxResults: 3 }, 30000);
      } catch (e) {
        searchResult = { success: false, error: e.message };
      }
      if (searchResult?.success && searchResult.data?.emails?.length > 0) break;
      if (Date.now() - start + pollInterval < timeout) {
        await new Promise(r => setTimeout(r, pollInterval));
      } else break;
    }

    if (!searchResult?.success || !searchResult.data?.emails?.length) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_email", message: "Magic link email not found within timeout" }) }] };
    }

    // Open the email
    try {
      await sendCommand("gmail_open_email", { index: 0 }, 15000);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "open_failed", message: e.message }) }] };
    }

    // Click the magic link
    try {
      const clickResult = await sendCommand("gmail_click_verification_link", { pattern, index: 0 }, 30000);
      if (clickResult?.success) {
        return { content: [{ type: "text", text: JSON.stringify({ success: true, method: "magic_link", url: clickResult.data?.url, title: clickResult.data?.title }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_link", message: clickResult?.error || "No magic link found in email" }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "click_failed", message: e.message }) }] };
    }
  }
);

server.tool(
  "auth_federation_detect",
  "Detect ALL available authentication methods on the current login page: password, Google OAuth, GitHub OAuth, Apple, Microsoft, SSO/SAML, magic link, phone/SMS, passkey. Returns a ranked list of options.",
  {},
  async () => {
    let loginInfo, ssoInfo, tabInfo;
    try {
      [loginInfo, ssoInfo, tabInfo] = await Promise.all([
        sendCommand("login_detect", {}, 15000),
        sendCommand("auth_sso_detect", {}, 10000),
        sendCommand("get_active_tab_info", {}, 5000),
      ]);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "detection_failed", message: e.message }) }] };
    }

    const url = tabInfo?.success ? tabInfo.data.url : "";
    const page = loginInfo?.success ? loginInfo.data : {};
    const sso = ssoInfo?.success ? ssoInfo.data : {};

    const methods = [];

    // OAuth providers
    if (page.has_oauth) {
      for (const provider of page.has_oauth) {
        methods.push({ method: provider + "_oauth", available: true, priority: provider === "google" ? 1 : 2 });
      }
    }

    // Password login
    if (page.has_password_field || page.username_selector) {
      methods.push({ method: "password", available: true, priority: 3 });
    }

    // SSO
    if (sso.is_sso_page) {
      methods.push({ method: "sso_" + (sso.provider || "generic"), available: true, protocol: sso.protocol, priority: 2 });
    }

    // Magic link
    let hasMagicLink = false;
    try {
      const magicCheck = await sendCommand("execute_js", {
        code: `(function() {
          var els = document.querySelectorAll('button, a, [role="button"]');
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].innerText || '').toLowerCase();
            if (/magic\s*link|email\s*me\s*a\s*link|passwordless|sign\s*in\s*with\s*email|email\s*login/i.test(t)) return true;
          }
          return false;
        })()`
      }, 5000);
      if (magicCheck?.success && magicCheck.data === true) {
        hasMagicLink = true;
        methods.push({ method: "magic_link", available: true, priority: 4 });
      }
    } catch (e) { /* ignore */ }

    // Phone/SMS
    let hasPhone = false;
    try {
      const phoneCheck = await sendCommand("execute_js", {
        code: `(function() {
          var els = document.querySelectorAll('button, a, [role="button"]');
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].innerText || '').toLowerCase();
            if (/phone|sms|text\s*message|mobile/i.test(t)) return true;
          }
          return !!document.querySelector('input[type="tel"]');
        })()`
      }, 5000);
      if (phoneCheck?.success && phoneCheck.data === true) {
        hasPhone = true;
        methods.push({ method: "phone_sms", available: true, priority: 5 });
      }
    } catch (e) { /* ignore */ }

    // Passkey / WebAuthn
    let hasPasskey = false;
    try {
      const passkeyCheck = await sendCommand("execute_js", {
        code: `(function() {
          var els = document.querySelectorAll('button, a, [role="button"]');
          for (var i = 0; i < els.length; i++) {
            var t = (els[i].innerText || '').toLowerCase();
            if (/passkey|biometric|fingerprint|face\s*id|security\s*key|webauthn/i.test(t)) return true;
          }
          return false;
        })()`
      }, 5000);
      if (passkeyCheck?.success && passkeyCheck.data === true) {
        hasPasskey = true;
        methods.push({ method: "passkey", available: true, priority: 6, note: "requires_manual" });
      }
    } catch (e) { /* ignore */ }

    // Sort by priority
    methods.sort((a, b) => a.priority - b.priority);

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          success: true,
          data: {
            url,
            methods,
            has_captcha: page.has_captcha || false,
            signup_link: page.signup_link || null,
          },
        }),
      }],
    };
  }
);

server.tool(
  "auth_federation_flow",
  "Master orchestrator for any authentication scenario. Tries each preferred method in order until one succeeds. Composes google_oauth_flow, login_flow, auth_magic_link_flow, auth_sso_flow. Handles all redirects and multi-step flows.",
  {
    service: z.string().describe("Keychain service name for credential/TOTP lookup"),
    email: z.string().optional().describe("Email address for authentication"),
    preferred_methods: z.array(z.string()).optional().describe("Ordered list of methods to try, e.g. ['google_oauth', 'password', 'magic_link']. Defaults to all available."),
    timeout_ms: z.number().optional().describe("Max time for entire flow in ms (default 60000)"),
  },
  async ({ service, email, preferred_methods, timeout_ms }) => {
    const timeout = timeout_ms || 60000;
    const start = Date.now();
    const attempts = [];

    // Step 1: Detect available methods
    let federationResult;
    try {
      federationResult = await sendCommand("execute_js", { code: "true" }, 3000); // Warm up
      const detectTabInfo = await sendCommand("get_active_tab_info", {}, 5000);
      const detectResult = await sendCommand("login_detect", {}, 15000);
      const page = detectResult?.success ? detectResult.data : {};

      const availableMethods = [];
      if (page.has_oauth) for (const p of page.has_oauth) availableMethods.push(p + "_oauth");
      if (page.has_password_field || page.username_selector) availableMethods.push("password");

      const methods = preferred_methods || availableMethods;
      if (methods.length === 0) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_methods", message: "No authentication methods detected on this page" }) }] };
      }

      // Step 2: Try each method
      for (const method of methods) {
        if (Date.now() - start >= timeout) break;
        const remaining = timeout - (Date.now() - start);

        if (method === "google_oauth" && email) {
          // Click Google OAuth button
          try {
            await sendCommand("execute_js", {
              code: `(function() { var els = document.querySelectorAll('button, a, [role="button"]'); for (var i = 0; i < els.length; i++) { var t = ((els[i].innerText||'')+(els[i].className||'')+(els[i].id||'')).toLowerCase(); if (/google/i.test(t)) { els[i].click(); return true; } } return false; })()`
            }, 5000);
            await new Promise(r => setTimeout(r, 3000));
            const oauthResult = await sendCommand("google_oauth_flow", { email, timeoutMs: Math.min(30000, remaining - 3000) }, 35000);
            if (oauthResult?.success && !oauthResult.data?.needs_password) {
              attempts.push({ method: "google_oauth", success: true });
              // Check final state
              await new Promise(r => setTimeout(r, 2000));
              const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
              return { content: [{ type: "text", text: JSON.stringify({ success: true, method: "google_oauth", logged_in_url: tabInfo?.data?.url, attempts }) }] };
            }
            if (oauthResult?.data?.needs_password) {
              try {
                const pw = await execSecurity(["find-generic-password", "-s", service, "-w"]);
                await sendCommand("fill_password", { selector: 'input[type="password"]', password: pw }, 5000);
                try { await sendCommand("click_element", { selector: "#passwordNext button, #passwordNext" }, 5000); } catch (e) { /* skip */ }
                await new Promise(r => setTimeout(r, 3000));
                const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
                attempts.push({ method: "google_oauth", success: true });
                return { content: [{ type: "text", text: JSON.stringify({ success: true, method: "google_oauth", logged_in_url: tabInfo?.data?.url, attempts }) }] };
              } catch (e) {
                attempts.push({ method: "google_oauth", success: false, reason: "needs_password" });
              }
            } else {
              attempts.push({ method: "google_oauth", success: false });
            }
          } catch (e) {
            attempts.push({ method: "google_oauth", success: false, reason: e.message });
          }
          // Navigate back to try next method
          try { await sendCommand("go_back", {}, 5000); await new Promise(r => setTimeout(r, 2000)); } catch (e) { /* skip */ }
          continue;
        }

        if (method === "password") {
          try {
            const pw = await execSecurity(["find-generic-password", "-s", service, "-w"]);
            let username = email;
            if (!username) {
              try {
                const info = await new Promise((resolve, reject) => {
                  execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-g"], { timeout: 10000 }, (err, stdout, stderr) => {
                    if (err && !stderr) reject(err); else resolve(stderr + "\n" + stdout);
                  });
                });
                const m = info.match(/"acct"<blob>="([^"]*)"/);
                if (m) username = m[1];
              } catch (e) { /* skip */ }
            }

            const redetect = await sendCommand("login_detect", {}, 10000);
            const rp = redetect?.success ? redetect.data : {};

            if (rp.username_selector && username) {
              await sendCommand("fill_field", { selector: rp.username_selector, value: username }, 5000);
            }
            if (rp.password_selector) {
              await sendCommand("fill_password", { selector: rp.password_selector, password: pw }, 5000);
            }
            if (rp.submit_selector) {
              await sendCommand("click_element", { selector: rp.submit_selector }, 5000);
            }

            await new Promise(r => setTimeout(r, 3000));
            const postCheck = await sendCommand("login_detect", {}, 10000);
            if (!postCheck?.success || !postCheck.data.is_login_page) {
              const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
              attempts.push({ method: "password", success: true });
              return { content: [{ type: "text", text: JSON.stringify({ success: true, method: "password", logged_in_url: tabInfo?.data?.url, attempts }) }] };
            }
            attempts.push({ method: "password", success: false, reason: postCheck.data.error_message || "still_on_login_page" });
          } catch (e) {
            attempts.push({ method: "password", success: false, reason: e.message });
          }
          continue;
        }

        if (method === "magic_link") {
          // Click the magic link button
          try {
            await sendCommand("execute_js", {
              code: `(function() { var els = document.querySelectorAll('button, a, [role="button"]'); for (var i = 0; i < els.length; i++) { var t = (els[i].innerText||'').toLowerCase(); if (/magic|email.*link|passwordless|email.*login/i.test(t)) { els[i].click(); return true; } } return false; })()`
            }, 5000);
            await new Promise(r => setTimeout(r, 2000));

            // Fill email if needed
            if (email) {
              const selectors = ['input[type="email"]', 'input[name="email"]', 'input#email'];
              for (const sel of selectors) {
                try { await sendCommand("fill_field", { selector: sel, value: email }, 3000); break; } catch (e) { continue; }
              }
              try { await sendCommand("click_element", { selector: 'button[type="submit"]' }, 3000); } catch (e) { /* skip */ }
            }

            attempts.push({ method: "magic_link", success: false, reason: "email_sent_check_inbox", note: "Use auth_magic_link_flow to complete" });
          } catch (e) {
            attempts.push({ method: "magic_link", success: false, reason: e.message });
          }
          continue;
        }

        // Generic OAuth (github, apple, microsoft, etc.)
        if (method.endsWith("_oauth")) {
          const providerName = method.replace("_oauth", "");
          try {
            await sendCommand("execute_js", {
              code: `(function() { var re = /${providerName}/i; var els = document.querySelectorAll('button, a, [role="button"]'); for (var i = 0; i < els.length; i++) { var t = ((els[i].innerText||'')+(els[i].className||'')+(els[i].id||'')).toLowerCase(); if (re.test(t)) { els[i].click(); return true; } } return false; })()`
            }, 5000);
            await new Promise(r => setTimeout(r, 3000));
            attempts.push({ method, success: false, reason: "oauth_redirect_started", note: "OAuth flow started but may need manual completion for " + providerName });
          } catch (e) {
            attempts.push({ method, success: false, reason: e.message });
          }
          try { await sendCommand("go_back", {}, 5000); await new Promise(r => setTimeout(r, 2000)); } catch (e) { /* skip */ }
          continue;
        }

        attempts.push({ method, success: false, reason: "unsupported_method" });
      }

      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "all_methods_failed", attempts }) }] };
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "error", message: e.message, attempts }) }] };
    }
  }
);

server.tool(
  "auth_session_check",
  "Check if the user is currently authenticated on the page. Looks for logged-in indicators: user avatar, profile menu, logout button, auth cookies, session storage tokens.",
  {},
  async () => formatResult(await sendCommand("auth_session_check", {}, 15000))
);

server.tool(
  "auth_session_refresh",
  "Attempt to re-authenticate when a session has expired. Detects redirect to login or 401 state, then uses stored credentials to log back in.",
  {
    service: z.string().describe("Keychain service name for credential lookup"),
    email: z.string().optional().describe("Email for account selection during re-auth"),
  },
  async ({ service, email }) => {
    // Check current session state
    let sessionInfo;
    try {
      sessionInfo = await sendCommand("auth_session_check", {}, 10000);
    } catch (e) {
      return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "check_failed", message: e.message }) }] };
    }

    if (sessionInfo?.success && sessionInfo.data.is_authenticated) {
      return { content: [{ type: "text", text: JSON.stringify({ success: true, status: "already_authenticated", indicators: sessionInfo.data.indicators }) }] };
    }

    // Check if we're on a login page (session expired redirect)
    let loginInfo;
    try {
      loginInfo = await sendCommand("login_detect", {}, 10000);
    } catch (e) { /* ignore */ }

    if (loginInfo?.success && loginInfo.data.is_login_page) {
      // We're on a login page — attempt re-login
      let password;
      try {
        password = await execSecurity(["find-generic-password", "-s", service, "-w"]);
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "needs_credentials", message: "Session expired but no credentials in Keychain for '" + service + "'" }) }] };
      }

      let username = email;
      if (!username) {
        try {
          const info = await new Promise((resolve, reject) => {
            execFile("/usr/bin/security", ["find-generic-password", "-s", service, "-g"], { timeout: 10000 }, (err, stdout, stderr) => {
              if (err && !stderr) reject(err); else resolve(stderr + "\n" + stdout);
            });
          });
          const m = info.match(/"acct"<blob>="([^"]*)"/);
          if (m) username = m[1];
        } catch (e) { /* skip */ }
      }

      const page = loginInfo.data;
      const actions = [];

      if (page.username_selector && username) {
        try { await sendCommand("fill_field", { selector: page.username_selector, value: username }, 5000); actions.push("filled_username"); } catch (e) { /* skip */ }
      }
      if (page.password_selector) {
        try { await sendCommand("fill_password", { selector: page.password_selector, password }, 5000); actions.push("filled_password"); } catch (e) { /* skip */ }
      }
      if (page.submit_selector) {
        try { await sendCommand("click_element", { selector: page.submit_selector }, 5000); actions.push("clicked_submit"); } catch (e) { /* skip */ }
      }

      await new Promise(r => setTimeout(r, 3000));
      const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);

      return { content: [{ type: "text", text: JSON.stringify({ success: true, status: "re_authenticated", logged_in_url: tabInfo?.data?.url, actions }) }] };
    }

    return { content: [{ type: "text", text: JSON.stringify({ success: false, reason: "no_login_page", message: "Session may have expired but no login page detected" }) }] };
  }
);

// --- Gmail / email verification ---

server.tool(
  "gmail_search",
  "Search Gmail by navigating to the Gmail web UI search URL and scraping the results. Returns email subjects, senders, snippets, and indices. Operates in the browser — does NOT use any API.",
  {
    query: z.string().describe("Gmail search query (e.g. 'from:noreply@example.com newer_than:1h')"),
    max_results: z.number().optional().describe("Maximum number of results to return (default 5)"),
  },
  async ({ query, max_results }) =>
    formatResult(await sendCommand("gmail_search", { query, maxResults: max_results }, 30000))
);

server.tool(
  "gmail_open_email",
  "Click the Nth email row in the current Gmail search/inbox view to open it",
  {
    index: z.number().describe("0-based index of the email row to open"),
  },
  async ({ index }) =>
    formatResult(await sendCommand("gmail_open_email", { index }, 15000))
);

server.tool(
  "gmail_find_verification_link",
  "Scan the currently open Gmail email body for links matching a pattern (e.g. 'verify', 'confirm', 'activate'). Returns matching link URLs and their text.",
  {
    pattern: z
      .string()
      .optional()
      .describe("Regex or substring to match in link URLs (default: common verification patterns like verify, confirm, activate)"),
  },
  async ({ pattern }) =>
    formatResult(await sendCommand("gmail_find_verification_link", { pattern }, 15000))
);

server.tool(
  "gmail_click_verification_link",
  "Find and click a verification/confirmation link in the currently open Gmail email. Opens the link in a new tab, waits for it to load, and returns the resulting URL and page title.",
  {
    pattern: z
      .string()
      .optional()
      .describe("Regex or substring to match in link URLs (default: common verification patterns)"),
    index: z
      .number()
      .optional()
      .describe("Which matching link to click if multiple are found (0-based, default 0)"),
  },
  async ({ pattern, index }) =>
    formatResult(await sendCommand("gmail_click_verification_link", { pattern, index }, 30000))
);

server.tool(
  "email_verify_flow",
  "High-level orchestrator: searches Gmail for a recent email from a sender, opens it, finds and clicks a verification link, and returns the result page URL. Polls with retries if the email has not arrived yet.",
  {
    sender: z.string().describe("Sender email or name to search for in Gmail"),
    link_pattern: z
      .string()
      .optional()
      .describe("Regex or substring to match in verification link URLs"),
    timeout_ms: z
      .number()
      .optional()
      .describe("Max time to wait for the email to arrive in ms (default 60000)"),
    poll_interval_ms: z
      .number()
      .optional()
      .describe("How often to re-check Gmail for new emails in ms (default 5000)"),
  },
  async ({ sender, link_pattern, timeout_ms, poll_interval_ms }) => {
    const timeout = timeout_ms || 60000;
    const pollInterval = poll_interval_ms || 5000;
    const start = Date.now();

    // Step 1: Poll Gmail for a matching email
    let searchResult;
    while (Date.now() - start < timeout) {
      try {
        searchResult = await sendCommand(
          "gmail_search",
          { query: `from:${sender} newer_than:1h`, maxResults: 3 },
          30000
        );
      } catch (e) {
        searchResult = { success: false, error: e.message };
      }

      if (searchResult.success && searchResult.data?.emails?.length > 0) {
        break;
      }

      // No email yet — wait and retry
      if (Date.now() - start + pollInterval < timeout) {
        await new Promise((r) => setTimeout(r, pollInterval));
      } else {
        break;
      }
    }

    if (!searchResult?.success || !searchResult.data?.emails?.length) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              reason: "timeout",
              message: `No email from '${sender}' found within ${timeout}ms`,
            }),
          },
        ],
      };
    }

    const emailSubject = searchResult.data.emails[0].subject || "(no subject)";

    // Step 2: Open the first matching email
    let openResult;
    try {
      openResult = await sendCommand("gmail_open_email", { index: 0 }, 15000);
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              reason: "open_failed",
              message: `Found email but failed to open it: ${e.message}`,
              email_subject: emailSubject,
            }),
          },
        ],
      };
    }

    if (!openResult.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              reason: "open_failed",
              message: `Found email but failed to open it: ${openResult.error}`,
              email_subject: emailSubject,
            }),
          },
        ],
      };
    }

    // Brief pause for email body to render
    await new Promise((r) => setTimeout(r, 1500));

    // Step 3: Find and click the verification link
    let clickResult;
    try {
      clickResult = await sendCommand(
        "gmail_click_verification_link",
        { pattern: link_pattern, index: 0 },
        30000
      );
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              reason: "no_link",
              message: `Opened email but failed to click verification link: ${e.message}`,
              email_subject: emailSubject,
            }),
          },
        ],
      };
    }

    if (!clickResult.success) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: false,
              reason: "no_link",
              message: `Opened email but no verification link found: ${clickResult.error}`,
              email_subject: emailSubject,
            }),
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            verified_url: clickResult.data?.url || null,
            page_title: clickResult.data?.title || null,
            email_subject: emailSubject,
          }),
        },
      ],
    };
  }
);

server.tool(
  "gmail_read_email",
  "Extract full content from the currently open email in Gmail: subject, from, to, cc, date, body text, and attachment names",
  {},
  async () =>
    formatResult(await sendCommand("gmail_read_email", {}, 15000))
);

server.tool(
  "gmail_compose",
  "Open a new Gmail compose window and fill in the To, Subject, Body, CC, and BCC fields. Does NOT automatically send the email.",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().optional().describe("Email subject line"),
    body: z.string().optional().describe("Email body text"),
    cc: z.string().optional().describe("CC recipient(s), comma-separated"),
    bcc: z.string().optional().describe("BCC recipient(s), comma-separated"),
  },
  async ({ to, subject, body, cc, bcc }) =>
    formatResult(await sendCommand("gmail_compose", { to, subject, body, cc, bcc }, 20000))
);

server.tool(
  "gmail_send",
  "Click the Send button on the currently open Gmail compose or reply window",
  {},
  async () =>
    formatResult(await sendCommand("gmail_send", {}, 15000))
);

server.tool(
  "gmail_reply",
  "Click Reply (or Reply All) on the currently open email in Gmail and fill in the body text. Does NOT automatically send.",
  {
    body: z.string().describe("Reply body text"),
    reply_all: z.boolean().optional().describe("Use Reply All instead of Reply (default false)"),
  },
  async ({ body, reply_all }) =>
    formatResult(await sendCommand("gmail_reply", { body, replyAll: reply_all }, 20000))
);

server.tool(
  "gmail_forward",
  "Click Forward on the currently open email in Gmail, fill in the recipient and optional body text. Does NOT automatically send.",
  {
    to: z.string().describe("Recipient email address to forward to"),
    body: z.string().optional().describe("Optional additional text to include above the forwarded message"),
  },
  async ({ to, body }) =>
    formatResult(await sendCommand("gmail_forward", { to, body }, 20000))
);

server.tool(
  "gmail_archive",
  "Archive the currently open email in Gmail (moves it out of the inbox)",
  {},
  async () =>
    formatResult(await sendCommand("gmail_archive", {}, 10000))
);

server.tool(
  "gmail_label",
  "Apply a label to the currently open email in Gmail using the Labels dropdown menu.",
  {
    label: z.string().describe("Label name to apply (e.g. 'Important', 'Work', or a custom label)"),
  },
  async ({ label }) =>
    formatResult(await sendCommand("gmail_label", { label }, 15000))
);

server.tool(
  "gmail_navigate",
  "Navigate Gmail to a specific section: inbox, sent, drafts, starred, trash, spam, or a label name",
  {
    section: z
      .string()
      .describe("Gmail section: 'inbox', 'sent', 'drafts', 'starred', 'trash', 'spam', 'all', or a label name"),
  },
  async ({ section }) =>
    formatResult(await sendCommand("gmail_navigate", { section }, 15000))
);

// ── CAPTCHA Tools ──

server.tool(
  "captcha_detect",
  "Scan the current page for known CAPTCHA types: reCAPTCHA v2 (checkbox), reCAPTCHA v3 (invisible), hCaptcha, Cloudflare Turnstile, Cloudflare challenge pages, and generic image CAPTCHAs. Returns the detected type, relevant CSS selector, iframe src, and whether the CAPTCHA is already solved.",
  {},
  async () => formatResult(await sendCommand("captcha_detect"))
);

server.tool(
  "captcha_click_checkbox",
  "Click the checkbox inside a reCAPTCHA v2 or hCaptcha iframe using coordinate-based clicking via chrome.debugger (bypasses cross-origin restrictions). Auto-detects the CAPTCHA type if not specified. After clicking, reports whether the CAPTCHA was solved immediately or if an image challenge appeared that needs manual solving.",
  {
    type: z
      .enum(["recaptcha_v2", "hcaptcha"])
      .optional()
      .describe("CAPTCHA type to click (auto-detects if omitted)"),
  },
  async ({ type }) =>
    formatResult(await sendCommand("captcha_click_checkbox", { type }, 10000))
);

server.tool(
  "captcha_wait_for_solve",
  "Poll the page waiting for a CAPTCHA to be solved (by the user manually or by a previous checkbox click succeeding). Checks reCAPTCHA/hCaptcha response tokens, Turnstile input values, and Cloudflare challenge page URL changes. Use after captcha_click_checkbox triggers an image challenge that requires human interaction.",
  {
    timeout_ms: z
      .number()
      .optional()
      .describe("Max wait time in ms (default 30000)"),
  },
  async ({ timeout_ms }) =>
    formatResult(
      await sendCommand(
        "captcha_wait_for_solve",
        { timeout_ms },
        (timeout_ms || 30000) + 5000
      )
    )
);

server.tool(
  "captcha_get_response",
  "Get the CAPTCHA response token if the CAPTCHA has been solved. Checks reCAPTCHA (grecaptcha.getResponse), hCaptcha (hcaptcha.getResponse), and Cloudflare Turnstile (cf-turnstile-response input). Returns the token string and CAPTCHA type.",
  {},
  async () => formatResult(await sendCommand("captcha_get_response"))
);

server.tool(
  "captcha_screenshot",
  "Take a targeted screenshot of the CAPTCHA challenge area. If an image challenge is visible (reCAPTCHA grid, hCaptcha image selection), crops the screenshot to just the challenge iframe. Falls back to a full page screenshot if the challenge cannot be located. Returns the image in the same format as browser_screenshot.",
  {},
  async () => {
    try {
      const result = await sendCommand("captcha_screenshot", {}, 15000);
      if (result && result.success) {
        const base64 = result.data.replace(/^data:image\/png;base64,/, "");
        const content = [{ type: "image", data: base64, mimeType: "image/png" }];
        if (result.meta) {
          content.push({ type: "text", text: JSON.stringify(result.meta) });
        }
        return { content };
      }
      return {
        content: [{ type: "text", text: result?.error || "CAPTCHA screenshot failed" }],
        isError: true,
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: `CAPTCHA screenshot failed: ${e.message}` }],
        isError: true,
      };
    }
  }
);

// ── ID Verification Tools ──

server.tool(
  "id_verify_detect",
  "Analyze the current page to detect if it is an identity verification flow (KYC, document upload, selfie, phone, address, or business verification). Detects form fields, file upload inputs, third-party providers (Stripe Identity, Persona, Jumio, Onfido, Veriff, Plaid), and verification type. Returns needs_manual_interaction: true for provider iframes that cannot be automated.",
  {},
  async () => formatResult(await sendCommand("id_verify_detect", {}, 15000))
);

server.tool(
  "id_verify_fill_personal",
  "Fill personal identity verification fields on the current page. Detects and matches form fields by label, name, placeholder, and aria-label. Handles inputs, textareas, and select dropdowns. Does NOT submit the form — leaves it ready for user review.",
  {
    data: z.object({
      first_name: z.string().optional().describe("First/given name"),
      last_name: z.string().optional().describe("Last/family name"),
      date_of_birth: z.string().optional().describe("Date of birth (format varies by form)"),
      address_line1: z.string().optional().describe("Street address line 1"),
      address_line2: z.string().optional().describe("Address line 2 (apt, suite, unit)"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State/province/region"),
      zip: z.string().optional().describe("ZIP/postal code"),
      country: z.string().optional().describe("Country name or code"),
      phone: z.string().optional().describe("Phone number"),
      ssn_last4: z.string().optional().describe("Last 4 digits of SSN"),
      tax_id: z.string().optional().describe("Full SSN or tax ID"),
    }).describe("Personal information to fill into detected fields"),
  },
  async ({ data }) =>
    formatResult(await sendCommand("id_verify_fill_personal", { data }, 15000))
);

server.tool(
  "id_verify_fill_business",
  "Fill business verification fields on the current page. Detects and matches business name, type, EIN, website, industry, and address fields. Does NOT submit the form — leaves it ready for user review.",
  {
    data: z.object({
      business_name: z.string().optional().describe("Legal business or company name"),
      business_type: z.string().optional().describe("Entity type: sole_proprietor, llc, corporation, partnership, etc."),
      ein: z.string().optional().describe("Employer Identification Number or tax ID"),
      website: z.string().optional().describe("Business website URL"),
      industry: z.string().optional().describe("Industry or business category"),
      address_line1: z.string().optional().describe("Business street address"),
      city: z.string().optional().describe("City"),
      state: z.string().optional().describe("State/province"),
      zip: z.string().optional().describe("ZIP/postal code"),
      country: z.string().optional().describe("Country"),
    }).describe("Business information to fill into detected fields"),
  },
  async ({ data }) =>
    formatResult(await sendCommand("id_verify_fill_business", { data }, 15000))
);

server.tool(
  "id_verify_upload_document",
  "Upload a document file to an identity verification form. Finds the appropriate file upload input on the page, optionally matching by document type. Uses the Chrome Debugger protocol to set files on the input element. Handles hidden file inputs behind styled upload buttons.",
  {
    file_path: z.string().describe("Absolute local path to the document file (image or PDF)"),
    document_type: z.string().optional().describe("Type of document: 'passport', 'drivers_license', 'id_card', 'proof_of_address', 'business_registration'"),
  },
  async ({ file_path, document_type }) =>
    formatResult(await sendCommand("id_verify_upload_document", { file_path, document_type }, 15000))
);

server.tool(
  "id_verify_phone",
  "Handle phone number verification flows. Detects whether the page shows a phone number entry or a verification code entry. Fills the phone number or OTP code as appropriate. Handles split-digit OTP inputs (6 individual boxes). Does NOT auto-submit.",
  {
    phone_number: z.string().optional().describe("Phone number to enter (if on phone entry page)"),
    code: z.string().optional().describe("Verification/OTP code to enter (if on code entry page)"),
  },
  async ({ phone_number, code }) =>
    formatResult(await sendCommand("id_verify_phone", { phone_number, code }, 15000))
);

server.tool(
  "id_verify_status",
  "Check the current page for identity verification status indicators. Detects: pending/in-review, approved/complete, failed/rejected states. Reads progress steps (e.g. step 2 of 4), error messages, and status headings.",
  {},
  async () => formatResult(await sendCommand("id_verify_status", {}, 15000))
);

// ── SMS Verification Tools ──

server.tool(
  "sms_verify_detect",
  "Detect if the current page is a phone/SMS verification page. Identifies phone number entry fields (with country code dropdowns), SMS code entry fields — handles ALL common patterns: single input, split digit boxes (6 individual maxlength=1 inputs), OTP autocomplete inputs, CodePuncher (Stripe), and hidden unified inputs. Also finds resend-code buttons. Returns the current state: needs_phone, needs_code, or code_entered.",
  {},
  async () => formatResult(await sendCommand("sms_verify_detect", {}, 15000))
);

server.tool(
  "sms_enter_phone",
  "Enter a phone number into a phone verification form. Detects the phone input field, handles country code dropdown selection, strips formatting from the number, and fills it in (React-compatible). Does NOT submit — returns the submit button selector so you can click it separately.",
  {
    phone: z.string().describe("Phone number — digits only or with country code like '+15551234567'"),
    country_code: z.string().optional().describe("Country code with + prefix (default '+1' for US)"),
  },
  async ({ phone, country_code }) =>
    formatResult(await sendCommand("sms_enter_phone", { phone, country_code: country_code || "+1" }, 15000))
);

server.tool(
  "sms_enter_code",
  "Enter a verification code on an SMS/phone verification page. Handles ALL code input patterns: single input fields, split digit boxes (dispatches input/change/key events between each digit and handles auto-advance), CodePuncher (Stripe) hidden control inputs, OTP autocomplete fields, and hidden unified inputs. After filling, reports whether a submit button is available (some forms auto-submit on the last digit).",
  {
    code: z.string().describe("The verification code to enter (e.g. '349447')"),
  },
  async ({ code }) =>
    formatResult(await sendCommand("sms_enter_code", { code }, 15000))
);

server.tool(
  "sms_read_from_messages",
  "Read the most recent SMS verification code from the macOS Messages app. Queries the Messages database (~/Library/Messages/chat.db) for recent messages matching verification code patterns (4-8 digit codes). Polls for new messages up to the timeout. Requires Full Disk Access permission for the MCP server process. Returns the extracted code, sender, and message text.",
  {
    timeout_ms: z.number().optional().describe("How long to poll for new messages in ms (default 30000)"),
    sender_pattern: z.string().optional().describe("Regex pattern to match sender — default matches short codes (5-6 digits) and common verification senders"),
  },
  async ({ timeout_ms, sender_pattern }) => {
    const timeout = timeout_ms || 30000;
    const startTime = Date.now();
    const senderRegex = sender_pattern || "^\\d{4,6}$|verify|auth|secure|code|alert";
    const codeRegex = /\b(\d{4,8})\b/;

    const dbPath = join(
      process.env.HOME || process.env.USERPROFILE || "/tmp",
      "Library/Messages/chat.db"
    );

    // Query Messages.app database for recent messages
    const query = `SELECT m.text, h.id as sender, datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as received_at FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID WHERE m.date > (strftime('%s','now') - 120 - 978307200) * 1000000000 AND m.is_from_me = 0 ORDER BY m.date DESC LIMIT 20`;

    const pollInterval = 3000;
    let lastChecked = "";

    while (Date.now() - startTime < timeout) {
      try {
        const result = await new Promise((resolve, reject) => {
          execFile("sqlite3", ["-json", dbPath, query], { timeout: 5000 }, (err, stdout, stderr) => {
            if (err) {
              if (err.message && (err.message.includes("unable to open") || err.message.includes("permission"))) {
                reject(new Error("Cannot access Messages database. Grant Full Disk Access to this process in System Settings > Privacy & Security > Full Disk Access."));
              } else {
                reject(err);
              }
              return;
            }
            resolve(stdout.trim());
          });
        });

        if (result && result !== lastChecked) {
          lastChecked = result;
          let messages;
          try {
            messages = JSON.parse(result);
          } catch {
            messages = [];
          }

          const senderRe = new RegExp(senderRegex, "i");
          for (const msg of messages) {
            const text = msg.text || "";
            const sender = msg.sender || "";
            // Check if sender matches pattern
            if (senderRegex && !senderRe.test(sender) && !senderRe.test(text)) {
              // Also check if message text itself looks like a verification message
              if (!/verif|code|confirm|otp|one.time|log.?in|sign.?in/i.test(text)) continue;
            }
            const codeMatch = text.match(codeRegex);
            if (codeMatch) {
              return {
                content: [{
                  type: "text",
                  text: JSON.stringify({
                    found: true,
                    code: codeMatch[1],
                    sender: sender,
                    message_text: text.substring(0, 200),
                    received_at: msg.received_at,
                  }),
                }],
              };
            }
          }
        }
      } catch (e) {
        return {
          content: [{ type: "text", text: JSON.stringify({ found: false, error: e.message }) }],
          isError: true,
        };
      }

      // Wait before polling again
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ found: false, timeout: true, message: "No verification code found within timeout" }),
      }],
    };
  }
);

server.tool(
  "sms_verify_flow",
  "Full SMS verification orchestrator. If on a phone entry page, enters the phone and submits. Waits for code entry page to appear. If auto_read is true, polls macOS Messages.app for the incoming code. If found, enters the code and waits for verification to complete. Returns the result of each step.",
  {
    phone: z.string().optional().describe("Phone number to enter (if still on phone entry page)"),
    country_code: z.string().optional().describe("Country code with + prefix (default '+1')"),
    auto_read: z.boolean().optional().describe("Try to read the verification code from Messages.app (default true)"),
    timeout_ms: z.number().optional().describe("Total timeout for the flow in ms (default 60000)"),
  },
  async ({ phone, country_code, auto_read, timeout_ms }) => {
    const timeout = timeout_ms || 60000;
    const shouldAutoRead = auto_read !== false;
    const startTime = Date.now();
    const actions = [];

    try {
      // Step 1: Detect current state
      let detection = await sendCommand("sms_verify_detect", {}, 10000);
      if (!detection.success) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Failed to detect SMS verification page", detail: detection.error }) }], isError: true };
      }

      let state = detection.data.state;
      actions.push({ step: "detect", state, is_sms_verify: detection.data.is_sms_verify });

      // Step 2: If needs phone and phone provided, enter it
      if (state === "needs_phone" && phone) {
        const phoneResult = await sendCommand("sms_enter_phone", { phone, country_code: country_code || "+1" }, 10000);
        if (!phoneResult.success) {
          return { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Failed to enter phone number", actions }) }], isError: true };
        }
        actions.push({ step: "phone_entered" });

        // Click submit if available
        if (phoneResult.data.submit_selector) {
          try {
            await sendCommand("click_element", { selector: phoneResult.data.submit_selector }, 5000);
            actions.push({ step: "phone_submitted" });
          } catch {
            actions.push({ step: "phone_submit_failed", message: "Could not click submit button" });
          }
        }

        // Wait for page to transition to code entry
        const waitStart = Date.now();
        while (Date.now() - waitStart < 10000 && Date.now() - startTime < timeout) {
          await new Promise((r) => setTimeout(r, 1000));
          detection = await sendCommand("sms_verify_detect", {}, 10000);
          if (detection.success && detection.data.state === "needs_code") {
            state = "needs_code";
            actions.push({ step: "transitioned_to_code_entry" });
            break;
          }
        }
      }

      if (state === "needs_phone" && !phone) {
        return { content: [{ type: "text", text: JSON.stringify({ success: false, state: "needs_phone", message: "Phone entry page detected but no phone number provided", actions }) }] };
      }

      // Step 3: Read code from Messages.app if auto_read enabled
      if (state === "needs_code" && shouldAutoRead) {
        actions.push({ step: "waiting_for_sms" });
        const remainingMs = Math.max(5000, timeout - (Date.now() - startTime));

        const dbPath = join(
          process.env.HOME || process.env.USERPROFILE || "/tmp",
          "Library/Messages/chat.db"
        );
        const query = `SELECT m.text, h.id as sender, datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime') as received_at FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID WHERE m.date > (strftime('%s','now') - 120 - 978307200) * 1000000000 AND m.is_from_me = 0 ORDER BY m.date DESC LIMIT 20`;
        const codeRegex = /\b(\d{4,8})\b/;
        const pollInterval = 3000;
        let foundCode = null;

        const readStart = Date.now();
        while (Date.now() - readStart < remainingMs && !foundCode) {
          try {
            const result = await new Promise((resolve, reject) => {
              execFile("sqlite3", ["-json", dbPath, query], { timeout: 5000 }, (err, stdout) => {
                if (err) { reject(err); return; }
                resolve(stdout.trim());
              });
            });
            if (result) {
              let messages;
              try { messages = JSON.parse(result); } catch { messages = []; }
              for (const msg of messages) {
                const text = msg.text || "";
                if (/verif|code|confirm|otp|one.time|log.?in|sign.?in/i.test(text)) {
                  const match = text.match(codeRegex);
                  if (match) { foundCode = match[1]; break; }
                }
              }
            }
          } catch {
            // DB access failed — fall through to manual
            actions.push({ step: "messages_db_unavailable" });
            break;
          }
          if (!foundCode) await new Promise((r) => setTimeout(r, pollInterval));
        }

        // Step 4: Enter code if found
        if (foundCode) {
          actions.push({ step: "code_found", method: "auto_read" });
          const enterResult = await sendCommand("sms_enter_code", { code: foundCode }, 10000);
          if (enterResult.success) {
            actions.push({ step: "code_entered", code_type: enterResult.data.code_type });

            // Try to submit if not auto-submitted
            if (enterResult.data.submit_available && !enterResult.data.auto_submitted) {
              // Re-detect to get submit selector
              const reDetect = await sendCommand("sms_verify_detect", {}, 5000);
              if (reDetect.success && reDetect.data.submit_selector) {
                try {
                  await sendCommand("click_element", { selector: reDetect.data.submit_selector }, 5000);
                  actions.push({ step: "code_submitted" });
                } catch {
                  actions.push({ step: "code_submit_failed" });
                }
              }
            }

            // Wait briefly for verification to complete
            await new Promise((r) => setTimeout(r, 2000));

            return {
              content: [{
                type: "text",
                text: JSON.stringify({ success: true, method: "auto_read", actions }),
              }],
            };
          } else {
            actions.push({ step: "code_entry_failed", error: enterResult.error });
          }
        } else {
          actions.push({ step: "no_code_received" });
        }
      }

      // If we get here, manual intervention is needed
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: false,
            state: state,
            message: state === "needs_code" ? "Verification code page detected. Enter code manually using sms_enter_code." : "Could not complete SMS verification flow",
            method: "manual",
            actions,
          }),
        }],
      };

    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ success: false, error: e.message, actions }) }],
        isError: true,
      };
    }
  }
);

// ── API Key Management Tools ──

server.tool(
  "api_key_store",
  "Store an API key securely in the macOS Keychain. Uses naming convention apikey-<service>-<key_name> for organized key management.",
  {
    service: z.string().describe("Service name (e.g. 'stripe', 'github', 'lemonsqueezy')"),
    key_name: z.string().describe("Key identifier (e.g. 'live', 'test', 'default')"),
    key_value: z.string().describe("The API key or token value to store"),
  },
  async ({ service, key_name, key_value }) => {
    const keychainService = `apikey-${service}-${key_name}`;
    try {
      await execSecurity([
        "add-generic-password",
        "-a", "api",
        "-s", keychainService,
        "-w", key_value,
        "-U",
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, service, key_name }),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: "Error: Failed to store API key" }],
        isError: true,
      };
    }
  }
);

server.tool(
  "api_key_retrieve",
  "Retrieve an API key from the macOS Keychain by service and key name.",
  {
    service: z.string().describe("Service name (e.g. 'stripe', 'github')"),
    key_name: z.string().default("default").describe("Key identifier (default: 'default')"),
  },
  async ({ service, key_name }) => {
    const keychainService = `apikey-${service}-${key_name}`;
    try {
      const key_value = await execSecurity([
        "find-generic-password",
        "-s", keychainService,
        "-a", "api",
        "-w",
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, key_value }),
        }],
      };
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, error: "not found" }),
        }],
      };
    }
  }
);

server.tool(
  "api_key_delete",
  "Remove an API key from the macOS Keychain.",
  {
    service: z.string().describe("Service name (e.g. 'stripe', 'github')"),
    key_name: z.string().describe("Key identifier (e.g. 'live', 'test', 'default')"),
  },
  async ({ service, key_name }) => {
    const keychainService = `apikey-${service}-${key_name}`;
    try {
      await execSecurity([
        "delete-generic-password",
        "-s", keychainService,
        "-a", "api",
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true }),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: "Error: Failed to delete API key" }],
        isError: true,
      };
    }
  }
);

server.tool(
  "api_key_list",
  "List stored API keys from the macOS Keychain. Returns key names only (never actual key values). Optionally filter by service name.",
  {
    service: z.string().optional().describe("Filter by service name (omit to list all stored API keys)"),
  },
  async ({ service }) => {
    try {
      const output = await new Promise((resolve, reject) => {
        execFile("/usr/bin/security", ["dump-keychain"], { timeout: 15000 }, (err, stdout, stderr) => {
          if (err) reject(new Error(stderr.trim() || err.message));
          else resolve(stdout);
        });
      });

      const prefix = service ? `apikey-${service}-` : "apikey-";
      const keys = [];
      const svceRegex = /"svce"<blob>="(apikey-([^"]+)-([^"]+))"/g;
      let match;
      while ((match = svceRegex.exec(output)) !== null) {
        const fullService = match[1];
        const svcName = match[2];
        const keyName = match[3];
        if (fullService.startsWith(prefix)) {
          // Avoid duplicates
          if (!keys.some(k => k.service === svcName && k.key_name === keyName)) {
            keys.push({ service: svcName, key_name: keyName });
          }
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ keys }),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: "Error: Failed to list API keys" }],
        isError: true,
      };
    }
  }
);

server.tool(
  "api_key_rotate",
  "Rotate (update) an existing API key in the macOS Keychain. Overwrites the old value with the new one.",
  {
    service: z.string().describe("Service name (e.g. 'stripe', 'github')"),
    key_name: z.string().describe("Key identifier (e.g. 'live', 'test', 'default')"),
    new_key_value: z.string().describe("The new API key value to replace the old one"),
  },
  async ({ service, key_name, new_key_value }) => {
    const keychainService = `apikey-${service}-${key_name}`;
    try {
      await execSecurity([
        "add-generic-password",
        "-a", "api",
        "-s", keychainService,
        "-w", new_key_value,
        "-U",
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: true, service, key_name, rotated: true }),
        }],
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: "Error: Failed to rotate API key" }],
        isError: true,
      };
    }
  }
);

server.tool(
  "api_key_use_header",
  "Retrieve an API key and return a formatted HTTP header ready for use in API calls. Supports Bearer, Token, Basic, X-API-Key, and custom header formats.",
  {
    service: z.string().describe("Service name (e.g. 'stripe', 'github')"),
    key_name: z.string().default("default").describe("Key identifier (default: 'default')"),
    header_format: z
      .enum(["Bearer", "Token", "Basic", "X-API-Key", "custom"])
      .default("Bearer")
      .describe("Header format: Bearer, Token, Basic, X-API-Key, or custom (default: Bearer)"),
    custom_header: z
      .string()
      .optional()
      .describe("Custom header name (required when header_format is 'custom')"),
  },
  async ({ service, key_name, header_format, custom_header }) => {
    const keychainService = `apikey-${service}-${key_name}`;
    let key_value;
    try {
      key_value = await execSecurity([
        "find-generic-password",
        "-s", keychainService,
        "-a", "api",
        "-w",
      ]);
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ success: false, error: "not found" }),
        }],
      };
    }

    let header_name;
    let header_value;

    switch (header_format) {
      case "Bearer":
        header_name = "Authorization";
        header_value = `Bearer ${key_value}`;
        break;
      case "Token":
        header_name = "Authorization";
        header_value = `Token ${key_value}`;
        break;
      case "Basic":
        header_name = "Authorization";
        header_value = `Basic ${Buffer.from(key_value).toString("base64")}`;
        break;
      case "X-API-Key":
        header_name = "X-API-Key";
        header_value = key_value;
        break;
      case "custom":
        if (!custom_header) {
          return {
            content: [{ type: "text", text: "Error: custom_header is required when header_format is 'custom'" }],
            isError: true,
          };
        }
        header_name = custom_header;
        header_value = key_value;
        break;
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ header_name, header_value }),
      }],
    };
  }
);

// ── DevTools Tools ──

server.tool(
  "devtools_console_log",
  "Capture all console messages (log, warn, error, info, debug) from the active tab for a specified duration using Chrome DevTools Protocol. Includes message text, level, source URL, line number, and stack traces.",
  {
    duration_ms: z
      .number()
      .optional()
      .describe("How long to capture console messages in ms (default 5000)"),
  },
  async ({ duration_ms }) =>
    formatResult(
      await sendCommand(
        "devtools_console_log",
        { duration_ms },
        (duration_ms || 5000) + 5000
      )
    )
);

server.tool(
  "devtools_performance_metrics",
  "Get current performance metrics from Chrome DevTools Protocol: JS heap size, DOM node count, layout count, style recalculations, and more. Instant snapshot — no duration needed.",
  {},
  async () => formatResult(await sendCommand("devtools_performance_metrics"))
);

server.tool(
  "devtools_performance_trace",
  "Record a Chrome performance trace for a duration, then return a summary of the top events. Useful for diagnosing slow pages, long tasks, and layout thrashing. Returns event counts by category and the longest individual events — NOT the raw trace data.",
  {
    duration_ms: z
      .number()
      .optional()
      .describe("How long to record the trace in ms (default 3000)"),
    categories: z
      .string()
      .optional()
      .describe("Comma-separated trace categories (default 'devtools.timeline,v8.execute')"),
  },
  async ({ duration_ms, categories }) =>
    formatResult(
      await sendCommand(
        "devtools_performance_trace",
        { duration_ms, categories },
        (duration_ms || 3000) + 10000
      )
    )
);

server.tool(
  "devtools_dom_tree",
  "Get a structured DOM tree from Chrome DevTools Protocol. Returns tag names, attributes, and text content to a specified depth. Optionally scoped to a CSS selector subtree.",
  {
    selector: z
      .string()
      .optional()
      .describe("CSS selector to get a subtree of (defaults to the entire document)"),
    depth: z
      .number()
      .optional()
      .describe("How many levels deep to traverse (default 3)"),
  },
  async ({ selector, depth }) =>
    formatResult(await sendCommand("devtools_dom_tree", { selector, depth }))
);

server.tool(
  "devtools_css_computed",
  "Get all computed CSS properties for an element using Chrome DevTools Protocol. Returns every resolved CSS property (display, position, width, height, color, font, etc.).",
  {
    selector: z.string().describe("CSS selector for the element to inspect"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("devtools_css_computed", { selector }))
);

server.tool(
  "devtools_network_throttle",
  "Simulate network conditions using Chrome DevTools Protocol. Preset profiles: slow3g (400kbps/2s latency), fast3g (1600kbps/562ms), offline, none (disable). Or provide custom values. Throttling persists until cleared with profile 'none'.",
  {
    profile: z
      .enum(["slow3g", "fast3g", "offline", "none"])
      .optional()
      .describe("Preset network profile"),
    download_kbps: z
      .number()
      .optional()
      .describe("Custom download speed in kbps (used when profile is omitted)"),
    upload_kbps: z
      .number()
      .optional()
      .describe("Custom upload speed in kbps (used when profile is omitted)"),
    latency_ms: z
      .number()
      .optional()
      .describe("Custom latency in ms (used when profile is omitted)"),
  },
  async ({ profile, download_kbps, upload_kbps, latency_ms }) =>
    formatResult(
      await sendCommand("devtools_network_throttle", {
        profile,
        download_kbps,
        upload_kbps,
        latency_ms,
      })
    )
);

server.tool(
  "devtools_cpu_throttle",
  "Simulate a slower CPU using Chrome DevTools Protocol. Rate is the slowdown factor (e.g. 4 means 4x slower, 6 means 6x slower). Use rate 1 to disable throttling. Throttling persists until explicitly cleared.",
  {
    rate: z
      .number()
      .describe("CPU throttle rate (e.g. 4 = 4x slowdown, 1 = no throttle)"),
  },
  async ({ rate }) =>
    formatResult(await sendCommand("devtools_cpu_throttle", { rate }))
);

server.tool(
  "devtools_coverage",
  "Measure JS and/or CSS code coverage on the active tab. Starts coverage profiling, waits for the specified duration, then reports used vs unused bytes per resource. Useful for finding unused code.",
  {
    type: z
      .enum(["js", "css", "both"])
      .optional()
      .describe("What to measure: 'js', 'css', or 'both' (default 'both')"),
    duration_ms: z
      .number()
      .optional()
      .describe("How long to profile in ms (default 5000)"),
  },
  async ({ type, duration_ms }) =>
    formatResult(
      await sendCommand(
        "devtools_coverage",
        { type, duration_ms },
        (duration_ms || 5000) + 5000
      )
    )
);

server.tool(
  "devtools_heap_snapshot",
  "Take a heap snapshot summary using Chrome DevTools Protocol. Returns total heap size and the top retained object types by size — NOT the full snapshot (which can be hundreds of MB). Useful for diagnosing memory leaks.",
  {},
  async () =>
    formatResult(await sendCommand("devtools_heap_snapshot", {}, 30000))
);

server.tool(
  "devtools_emulate_device",
  "Emulate a mobile or custom device using Chrome DevTools Protocol. Sets viewport size, device scale factor, and optionally user agent. Presets: iphone14, ipad, pixel7, desktop1080p, or custom dimensions. Emulation persists until the debugger detaches.",
  {
    device: z
      .enum(["iphone14", "ipad", "pixel7", "desktop1080p", "custom"])
      .optional()
      .describe("Device preset name, or 'custom' for manual dimensions"),
    width: z
      .number()
      .optional()
      .describe("Viewport width in pixels (for custom device)"),
    height: z
      .number()
      .optional()
      .describe("Viewport height in pixels (for custom device)"),
    device_scale: z
      .number()
      .optional()
      .describe("Device pixel ratio (for custom device, default 1)"),
    mobile: z
      .boolean()
      .optional()
      .describe("Whether to emulate a mobile device (for custom device)"),
    user_agent: z
      .string()
      .optional()
      .describe("Custom user agent string (for custom device)"),
  },
  async ({ device, width, height, device_scale, mobile, user_agent }) =>
    formatResult(
      await sendCommand("devtools_emulate_device", {
        device,
        width,
        height,
        device_scale,
        mobile,
        user_agent,
      })
    )
);

// ── Keyboard Shortcut Tools ──

server.tool(
  "keyboard_shortcut",
  "Execute a keyboard shortcut using common notation. Handles single shortcuts (Ctrl+C, Cmd+V), sequences (Ctrl+A Ctrl+C — space-separated), cross-platform naming (Cmd maps to Meta on Mac), and named keys (Enter, Escape, Tab, F1-F12, ArrowUp, etc.). Uses CDP Input.dispatchKeyEvent for reliable key simulation.",
  {
    shortcut: z
      .string()
      .describe("Shortcut notation, e.g. 'Ctrl+C', 'Cmd+Shift+P', 'Ctrl+A Ctrl+C' (space-separated for sequences)"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector for element to focus before pressing the shortcut"),
  },
  async ({ shortcut, selector }) =>
    formatResult(await sendCommand("keyboard_shortcut", { shortcut, selector }))
);

server.tool(
  "keyboard_type_text",
  "Type text character by character with realistic delays using CDP Input.dispatchKeyEvent. More reliable than browser_fill_field for apps that listen to individual keystrokes (code editors, terminal emulators, games). Dispatches keyDown, char, and keyUp events for each character.",
  {
    text: z.string().describe("Text to type character by character"),
    delay_ms: z
      .number()
      .optional()
      .describe("Delay between keystrokes in ms (default 50)"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector for element to focus before typing"),
  },
  async ({ text, delay_ms, selector }) => {
    const totalTimeout = (text.length * (delay_ms || 50)) + 5000;
    return formatResult(
      await sendCommand("keyboard_type_text", { text, delay_ms, selector }, totalTimeout)
    );
  }
);

server.tool(
  "keyboard_hold_key",
  "Simulate holding a key down for a duration (keyDown, wait, keyUp). Useful for games, drag operations, scroll acceleration, or apps that respond to key hold duration.",
  {
    key: z.string().describe("Key to hold (e.g. 'Space', 'ArrowDown', 'Shift', 'a')"),
    duration_ms: z
      .number()
      .optional()
      .describe("How long to hold the key in ms (default 500)"),
  },
  async ({ key, duration_ms }) =>
    formatResult(
      await sendCommand("keyboard_hold_key", { key, duration_ms }, (duration_ms || 500) + 5000)
    )
);

server.tool(
  "keyboard_combo",
  "Press multiple keys simultaneously by pressing all keys down in order then releasing in reverse order. More explicit than keyboard_shortcut for complex combinations like Ctrl+Shift+Alt+I.",
  {
    keys: z
      .array(z.string())
      .describe("Keys to press simultaneously, e.g. ['Ctrl', 'Shift', 'I']"),
  },
  async ({ keys }) =>
    formatResult(await sendCommand("keyboard_combo", { keys }))
);

server.tool(
  "keyboard_record",
  "Record all keyboard events on the page for a specified duration. Returns the sequence of keys pressed with timestamps and modifier state. Useful for understanding what shortcuts an app uses or recording a key sequence to replay. WARNING: This blocks all other browser commands for the entire recording duration.",
  {
    duration_ms: z
      .number()
      .optional()
      .describe("How long to record keyboard events in ms (default 5000)"),
  },
  async ({ duration_ms }) =>
    formatResult(
      await sendCommand(
        "keyboard_record",
        { duration_ms },
        (duration_ms || 5000) + 5000
      )
    )
);

server.tool(
  "keyboard_shortcuts_list",
  "Scan the current page for keyboard shortcut definitions. Inspects accesskey attributes, aria-keyshortcuts, title attributes with shortcut notation, data-shortcut/data-hotkey attributes, <kbd> elements, and shortcut documentation sections. Returns all discovered shortcuts with their descriptions and element selectors.",
  {},
  async () =>
    formatResult(await sendCommand("keyboard_shortcuts_list"))
);

// ── Developer Workflow Tools ──

const BASELINES_DIR = join(__dirname, "baselines");

server.tool(
  "dev_test_flow",
  "Run an automated QA test flow: navigate to a URL, execute a sequence of steps (click, fill, wait, assert, screenshot), and return a structured pass/fail report with timing.",
  {
    url: z.string().describe("URL to navigate to before running steps"),
    steps: z.array(z.object({
      action: z.enum(["click", "fill", "wait", "assert_text", "screenshot"]).describe("Action to perform"),
      selector: z.string().optional().describe("CSS selector (required for click, fill, wait, assert_text)"),
      value: z.string().optional().describe("Value for fill action or expected text for assert_text"),
      screenshot: z.boolean().optional().describe("Take a screenshot after this step"),
    })).describe("Ordered list of test steps to execute"),
    report: z.boolean().optional().describe("Include a summary report (default true)"),
  },
  async ({ url, steps, report }) => {
    const results = [];
    let passed = 0;
    let failed = 0;

    // Navigate to the URL
    try {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    } catch (e) {
      return {
        content: [{ type: "text", text: JSON.stringify({ passed: 0, failed: 1, total: 1, steps: [{ step: 0, action: "navigate", result: "fail", error: e.message }] }, null, 2) }],
        isError: true,
      };
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const start = Date.now();
      const entry = { step: i + 1, action: step.action };

      try {
        switch (step.action) {
          case "click":
            await sendCommand("click_element", { selector: step.selector });
            entry.result = "pass";
            break;

          case "fill":
            await sendCommand("fill_field", { selector: step.selector, value: step.value || "" });
            entry.result = "pass";
            break;

          case "wait":
            await sendCommand("wait_for_element", { selector: step.selector, timeoutMs: 10000 }, 12000);
            entry.result = "pass";
            break;

          case "assert_text": {
            const textResult = await sendCommand("get_page_content", { selector: step.selector });
            if (textResult && textResult.success) {
              const pageText = typeof textResult.data === "string" ? textResult.data : JSON.stringify(textResult.data);
              if (pageText.includes(step.value || "")) {
                entry.result = "pass";
              } else {
                entry.result = "fail";
                entry.error = `Expected text "${step.value}" not found in element`;
              }
            } else {
              entry.result = "fail";
              entry.error = textResult?.error || "Could not get element text";
            }
            break;
          }

          case "screenshot": {
            const ssResult = await sendCommand("take_screenshot");
            if (ssResult && ssResult.success) {
              entry.result = "pass";
              entry.screenshot = ssResult.data.replace(/^data:image\/png;base64,/, "");
            } else {
              entry.result = "pass";
              entry.screenshot_error = "Screenshot failed but step not counted as failure";
            }
            break;
          }
        }
      } catch (e) {
        entry.result = "fail";
        entry.error = e.message;
      }

      entry.duration_ms = Date.now() - start;
      if (step.screenshot && step.action !== "screenshot") {
        try {
          const ssResult = await sendCommand("take_screenshot");
          if (ssResult && ssResult.success) {
            entry.screenshot = ssResult.data.replace(/^data:image\/png;base64,/, "");
          }
        } catch {}
      }

      if (entry.result === "pass") passed++;
      else failed++;

      results.push(entry);
    }

    const output = { passed, failed, total: steps.length, steps: results };

    // Build content array: text report + any inline screenshots
    const content = [{ type: "text", text: JSON.stringify(output, (key, val) => key === "screenshot" ? "(base64 image)" : val, 2) }];
    for (const r of results) {
      if (r.screenshot) {
        content.push({ type: "image", data: r.screenshot, mimeType: "image/png" });
      }
    }
    return { content };
  }
);

server.tool(
  "dev_lighthouse",
  "Run a lightweight performance and accessibility audit on the current (or specified) page. Measures load time, DOM size, network requests, JS heap, and checks for common accessibility issues. Not full Lighthouse — a fast, dev-friendly summary.",
  {
    url: z.string().optional().describe("URL to audit (uses current page if omitted)"),
    categories: z.array(z.enum(["performance", "accessibility", "best-practices", "seo"]))
      .optional()
      .describe("Audit categories to include (default all four)"),
  },
  async ({ url, categories }) => {
    const cats = categories || ["performance", "accessibility", "best-practices", "seo"];

    // Navigate if URL provided
    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Get tab info for the URL
    const tabInfo = await sendCommand("get_active_tab_info");
    const pageUrl = tabInfo?.data?.url || url || "unknown";

    const result = { url: pageUrl, scores: {}, metrics: {}, issues: [] };

    // Performance metrics via DevTools
    if (cats.includes("performance")) {
      try {
        const perfResult = await sendCommand("devtools_performance_metrics");
        if (perfResult?.success && perfResult.data) {
          const metrics = Array.isArray(perfResult.data) ? perfResult.data : (perfResult.data.metrics || []);
          const metricMap = {};
          if (Array.isArray(metrics)) {
            for (const m of metrics) {
              if (m.name && m.value !== undefined) metricMap[m.name] = m.value;
            }
          }
          result.metrics.dom_nodes = metricMap["Nodes"] || 0;
          result.metrics.js_heap_mb = metricMap["JSHeapUsedSize"] ? Math.round(metricMap["JSHeapUsedSize"] / 1048576 * 100) / 100 : 0;
          result.metrics.layout_count = metricMap["LayoutCount"] || 0;
          result.metrics.style_recalcs = metricMap["RecalcStyleCount"] || 0;
        }
      } catch {}

      // Measure load timing and request count via JS
      try {
        const timingResult = await sendCommand("execute_js", { code: `
          (() => {
            const nav = performance.getEntriesByType('navigation')[0];
            const resources = performance.getEntriesByType('resource');
            return JSON.stringify({
              load_time_ms: nav ? Math.round(nav.loadEventEnd - nav.startTime) : 0,
              dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : 0,
              ttfb_ms: nav ? Math.round(nav.responseStart - nav.startTime) : 0,
              requests: resources.length,
              total_transfer_kb: Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024)
            });
          })()
        ` });
        if (timingResult?.success) {
          const timing = JSON.parse(timingResult.data);
          result.metrics.load_time_ms = timing.load_time_ms;
          result.metrics.dom_content_loaded_ms = timing.dom_content_loaded_ms;
          result.metrics.ttfb_ms = timing.ttfb_ms;
          result.metrics.requests = timing.requests;
          result.metrics.total_transfer_kb = timing.total_transfer_kb;
        }
      } catch {}

      // Score performance 0-100 based on metrics
      let perfScore = 100;
      if (result.metrics.load_time_ms > 3000) perfScore -= 20;
      if (result.metrics.load_time_ms > 5000) perfScore -= 20;
      if (result.metrics.dom_nodes > 1500) perfScore -= 10;
      if (result.metrics.dom_nodes > 3000) perfScore -= 10;
      if (result.metrics.js_heap_mb > 50) perfScore -= 10;
      if (result.metrics.requests > 50) perfScore -= 10;
      if (result.metrics.requests > 100) perfScore -= 10;
      result.scores.performance = Math.max(0, perfScore);

      if (result.metrics.load_time_ms > 3000) result.issues.push({ category: "performance", severity: "warning", message: `Slow load time: ${result.metrics.load_time_ms}ms (target < 3000ms)` });
      if (result.metrics.dom_nodes > 1500) result.issues.push({ category: "performance", severity: "warning", message: `Large DOM: ${result.metrics.dom_nodes} nodes (target < 1500)` });
      if (result.metrics.js_heap_mb > 50) result.issues.push({ category: "performance", severity: "warning", message: `High JS heap usage: ${result.metrics.js_heap_mb}MB` });
    }

    // Accessibility audit via JS (axe-core patterns)
    if (cats.includes("accessibility")) {
      try {
        const a11yResult = await sendCommand("execute_js", { code: `
          (() => {
            const issues = [];
            // Images without alt
            document.querySelectorAll('img:not([alt])').forEach(img => {
              issues.push({ rule: 'img-alt', message: 'Image missing alt attribute', selector: img.tagName + (img.className ? '.' + img.className.split(' ')[0] : '') });
            });
            // Empty alt on non-decorative images
            document.querySelectorAll('img[alt=""]').forEach(img => {
              if (img.width > 1 && img.height > 1) {
                issues.push({ rule: 'img-alt-empty', message: 'Potentially meaningful image has empty alt', selector: img.tagName });
              }
            });
            // Inputs without labels
            document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select').forEach(el => {
              const id = el.id;
              const hasLabel = id && document.querySelector('label[for="' + id + '"]');
              const hasAriaLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
              const wrappedInLabel = el.closest('label');
              if (!hasLabel && !hasAriaLabel && !wrappedInLabel) {
                issues.push({ rule: 'label', message: 'Form field missing label', selector: el.tagName + (el.name ? '[name=' + el.name + ']' : '') });
              }
            });
            // Missing lang on html
            if (!document.documentElement.getAttribute('lang')) {
              issues.push({ rule: 'html-has-lang', message: 'HTML element missing lang attribute' });
            }
            // Empty buttons and links
            document.querySelectorAll('button, a[href]').forEach(el => {
              const text = (el.textContent || '').trim();
              const ariaLabel = el.getAttribute('aria-label');
              const hasImg = el.querySelector('img[alt]');
              if (!text && !ariaLabel && !hasImg) {
                issues.push({ rule: 'empty-interactive', message: 'Empty ' + el.tagName.toLowerCase() + ' (no text, aria-label, or img with alt)', selector: el.tagName });
              }
            });
            // Insufficient color contrast check on large/heading text
            const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
            const missingHeading = headings.length === 0;
            if (missingHeading) {
              issues.push({ rule: 'heading-order', message: 'Page has no headings' });
            }
            // Check for skip-nav link
            const firstLink = document.querySelector('a[href^="#"]');
            if (!firstLink || !firstLink.textContent.toLowerCase().includes('skip')) {
              issues.push({ rule: 'skip-link', message: 'No skip-to-content link found', severity: 'info' });
            }
            return JSON.stringify({ count: issues.length, issues: issues.slice(0, 20) });
          })()
        ` });
        if (a11yResult?.success) {
          const a11y = JSON.parse(a11yResult.data);
          let a11yScore = 100 - (a11y.count * 5);
          result.scores.accessibility = Math.max(0, Math.min(100, a11yScore));
          for (const issue of a11y.issues) {
            result.issues.push({ category: "accessibility", severity: issue.severity || "warning", rule: issue.rule, message: issue.message, selector: issue.selector });
          }
        }
      } catch {}
    }

    // Best practices
    if (cats.includes("best-practices")) {
      try {
        const bpResult = await sendCommand("execute_js", { code: `
          (() => {
            const issues = [];
            if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
              issues.push({ rule: 'https', message: 'Page not served over HTTPS' });
            }
            if (!document.querySelector('meta[name="viewport"]')) {
              issues.push({ rule: 'viewport', message: 'Missing viewport meta tag' });
            }
            if (!document.doctype) {
              issues.push({ rule: 'doctype', message: 'Missing DOCTYPE declaration' });
            }
            const mixedContent = document.querySelectorAll('img[src^="http:"], script[src^="http:"], link[href^="http:"]');
            if (mixedContent.length > 0) {
              issues.push({ rule: 'mixed-content', message: mixedContent.length + ' resources loaded over HTTP (mixed content)' });
            }
            // Check for console errors already logged
            return JSON.stringify({ count: issues.length, issues });
          })()
        ` });
        if (bpResult?.success) {
          const bp = JSON.parse(bpResult.data);
          for (const issue of bp.issues) {
            result.issues.push({ category: "best-practices", severity: "warning", rule: issue.rule, message: issue.message });
          }
        }
      } catch {}
    }

    // SEO
    if (cats.includes("seo")) {
      try {
        const seoResult = await sendCommand("execute_js", { code: `
          (() => {
            const issues = [];
            if (!document.title || document.title.trim().length === 0) {
              issues.push({ rule: 'title', message: 'Page has no title' });
            } else if (document.title.length > 60) {
              issues.push({ rule: 'title-length', message: 'Title too long (' + document.title.length + ' chars, recommend < 60)' });
            }
            const metaDesc = document.querySelector('meta[name="description"]');
            if (!metaDesc || !metaDesc.content.trim()) {
              issues.push({ rule: 'meta-description', message: 'Missing meta description' });
            }
            const h1s = document.querySelectorAll('h1');
            if (h1s.length === 0) {
              issues.push({ rule: 'h1', message: 'Page has no h1 element' });
            } else if (h1s.length > 1) {
              issues.push({ rule: 'h1-multiple', message: 'Page has ' + h1s.length + ' h1 elements (recommend 1)' });
            }
            const canonical = document.querySelector('link[rel="canonical"]');
            if (!canonical) {
              issues.push({ rule: 'canonical', message: 'Missing canonical link' });
            }
            return JSON.stringify({ count: issues.length, issues });
          })()
        ` });
        if (seoResult?.success) {
          const seo = JSON.parse(seoResult.data);
          for (const issue of seo.issues) {
            result.issues.push({ category: "seo", severity: "info", rule: issue.rule, message: issue.message });
          }
        }
      } catch {}
    }

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "dev_form_test",
  "Test a form on the current page: detect fields, fill with test data, check client-side validation, and optionally submit. Returns what fields were found, filled, and any validation errors.",
  {
    form_selector: z.string().optional().describe("CSS selector for the form (auto-detects if omitted)"),
    test_data: z.record(z.string()).describe("Object mapping field names/selectors to test values"),
    submit: z.boolean().optional().describe("Whether to submit the form after filling (default false)"),
  },
  async ({ form_selector, test_data, submit }) => {
    const formSel = form_selector || "form";

    // Detect all fields in the form
    const fieldsResult = await sendCommand("execute_js", { code: `
      (() => {
        const form = document.querySelector(${JSON.stringify(formSel)});
        if (!form) return JSON.stringify({ error: 'Form not found: ${formSel}' });
        const fields = [];
        form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select').forEach((el, i) => {
          fields.push({
            index: i,
            tag: el.tagName.toLowerCase(),
            type: el.type || 'text',
            name: el.name || '',
            id: el.id || '',
            placeholder: el.placeholder || '',
            required: el.required,
            selector: el.id ? '#' + el.id : (el.name ? '${formSel} [name="' + el.name + '"]' : '${formSel} ' + el.tagName.toLowerCase() + ':nth-of-type(' + (i + 1) + ')'),
          });
        });
        return JSON.stringify({ fields });
      })()
    ` });

    if (!fieldsResult?.success) {
      return { content: [{ type: "text", text: JSON.stringify({ error: fieldsResult?.error || "Could not detect form fields" }) }], isError: true };
    }

    const fieldInfo = JSON.parse(fieldsResult.data);
    if (fieldInfo.error) {
      return { content: [{ type: "text", text: JSON.stringify({ error: fieldInfo.error }) }], isError: true };
    }

    const fields = fieldInfo.fields;
    let filled = 0;
    const validationErrors = [];

    // Fill each field that matches test_data keys
    for (const field of fields) {
      const dataKey = test_data[field.name] !== undefined ? field.name
        : test_data[field.id] !== undefined ? field.id
        : test_data[field.selector] !== undefined ? field.selector
        : null;

      if (dataKey) {
        const value = test_data[dataKey];
        try {
          await sendCommand("fill_field", { selector: field.selector, value });
          filled++;
        } catch (e) {
          validationErrors.push({ field: dataKey, error: `Fill failed: ${e.message}` });
        }
      }
    }

    // Check client-side validation
    const validResult = await sendCommand("execute_js", { code: `
      (() => {
        const form = document.querySelector(${JSON.stringify(formSel)});
        if (!form) return JSON.stringify({ errors: [] });
        const errors = [];
        form.querySelectorAll('input, textarea, select').forEach(el => {
          if (!el.checkValidity()) {
            errors.push({
              field: el.name || el.id || el.tagName,
              message: el.validationMessage,
              selector: el.id ? '#' + el.id : (el.name ? '[name="' + el.name + '"]' : el.tagName)
            });
          }
        });
        return JSON.stringify({ errors, formValid: form.checkValidity() });
      })()
    ` });

    if (validResult?.success) {
      const v = JSON.parse(validResult.data);
      for (const e of v.errors) {
        validationErrors.push({ field: e.field, message: e.message });
      }
    }

    let submitted = false;
    if (submit) {
      try {
        await sendCommand("execute_js", { code: `document.querySelector(${JSON.stringify(formSel)}).submit()` });
        submitted = true;
        await sendCommand("wait_for_load", { timeoutMs: 10000 }, 12000).catch(() => {});
      } catch (e) {
        validationErrors.push({ field: "__submit__", error: `Submit failed: ${e.message}` });
      }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          fields_found: fields.length,
          fields_filled: filled,
          validation_errors: validationErrors,
          submitted,
          field_details: fields,
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "dev_responsive_check",
  "Test responsive design by taking screenshots at multiple viewport sizes (mobile, tablet, desktop). Resizes the browser for each viewport, waits for the page to settle, and returns screenshots with viewport info.",
  {
    url: z.string().optional().describe("URL to test (uses current page if omitted)"),
    viewports: z.array(z.object({
      w: z.number().describe("Viewport width in pixels"),
      h: z.number().describe("Viewport height in pixels"),
      name: z.string().optional().describe("Label for this viewport"),
    })).optional().describe("Viewports to test (default: iPhone 375x812, iPad 768x1024, Desktop 1280x800)"),
  },
  async ({ url, viewports }) => {
    const vps = viewports || [
      { w: 375, h: 812, name: "iPhone" },
      { w: 768, h: 1024, name: "iPad" },
      { w: 1280, h: 800, name: "Desktop" },
    ];

    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Get current tab title
    const tabInfo = await sendCommand("get_active_tab_info");
    const pageTitle = tabInfo?.data?.title || "unknown";

    const results = [];
    const content = [];

    for (const vp of vps) {
      const vpName = vp.name || `${vp.w}x${vp.h}`;
      await sendCommand("set_viewport", { width: vp.w, height: vp.h });
      // Brief wait for responsive layout to settle
      await new Promise(r => setTimeout(r, 500));

      let screenshot = null;
      try {
        const ssResult = await sendCommand("take_screenshot");
        if (ssResult?.success) {
          screenshot = ssResult.data.replace(/^data:image\/png;base64,/, "");
        }
      } catch {}

      results.push({ viewport: vpName, width: vp.w, height: vp.h, page_title: pageTitle, has_screenshot: !!screenshot });
      if (screenshot) {
        content.push({ type: "text", text: `--- ${vpName} (${vp.w}x${vp.h}) ---` });
        content.push({ type: "image", data: screenshot, mimeType: "image/png" });
      }
    }

    // Restore to a reasonable default
    await sendCommand("set_viewport", { width: 1280, height: 800 }).catch(() => {});

    content.unshift({ type: "text", text: JSON.stringify({ results }, null, 2) });
    return { content };
  }
);

server.tool(
  "dev_api_test",
  "Test an API endpoint from the browser context using fetch. Sends a request and returns status, headers, body, timing, and pass/fail based on expected status.",
  {
    url: z.string().describe("API endpoint URL to test"),
    method: z.string().optional().describe("HTTP method (default GET)"),
    headers: z.record(z.string()).optional().describe("Request headers as key-value pairs"),
    body: z.string().optional().describe("Request body (for POST/PUT/PATCH)"),
    expected_status: z.number().optional().describe("Expected HTTP status code to check against"),
  },
  async ({ url: apiUrl, method, headers, body, expected_status }) => {
    const fetchMethod = method || "GET";
    const fetchHeaders = headers ? JSON.stringify(headers) : "{}";
    const fetchBody = body ? JSON.stringify(body) : "null";

    const result = await sendCommand("execute_js", { code: `
      (async () => {
        const start = performance.now();
        try {
          const opts = {
            method: ${JSON.stringify(fetchMethod)},
            headers: ${fetchHeaders},
          };
          const bodyVal = ${fetchBody};
          if (bodyVal && ${JSON.stringify(fetchMethod)} !== 'GET' && ${JSON.stringify(fetchMethod)} !== 'HEAD') {
            opts.body = bodyVal;
          }
          const res = await fetch(${JSON.stringify(apiUrl)}, opts);
          const duration = Math.round(performance.now() - start);
          const resHeaders = {};
          res.headers.forEach((v, k) => { resHeaders[k] = v; });
          let resBody;
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            try { resBody = await res.json(); } catch { resBody = await res.text(); }
          } else {
            resBody = await res.text();
            if (resBody.length > 5000) resBody = resBody.slice(0, 5000) + '... (truncated)';
          }
          return JSON.stringify({
            status: res.status,
            status_text: res.statusText,
            headers: resHeaders,
            body: resBody,
            duration_ms: duration,
          });
        } catch (e) {
          return JSON.stringify({ error: e.message, duration_ms: Math.round(performance.now() - start) });
        }
      })()
    ` }, 30000);

    if (!result?.success) {
      return { content: [{ type: "text", text: JSON.stringify({ error: result?.error || "Fetch failed" }) }], isError: true };
    }

    const data = JSON.parse(result.data);
    if (data.error) {
      return { content: [{ type: "text", text: JSON.stringify({ error: data.error, duration_ms: data.duration_ms, passed: false }) }], isError: true };
    }

    data.passed = expected_status ? data.status === expected_status : data.status >= 200 && data.status < 400;
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  }
);

server.tool(
  "dev_console_check",
  "Monitor the browser console for errors and warnings over a duration. Navigates to a URL if provided, then captures all console output. Reports whether the console is clean or has issues matching the specified fail levels.",
  {
    url: z.string().optional().describe("URL to navigate to before monitoring (uses current page if omitted)"),
    duration_ms: z.number().optional().describe("How long to monitor the console in ms (default 5000)"),
    fail_on: z.array(z.enum(["error", "warning", "info", "log"])).optional().describe("Console levels that count as failures (default ['error'])"),
  },
  async ({ url, duration_ms, fail_on }) => {
    const duration = duration_ms || 5000;
    const failLevels = fail_on || ["error"];

    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Use devtools console log capture
    const consoleResult = await sendCommand("devtools_console_log", { duration_ms: duration }, duration + 5000);

    const messages = [];
    let errorCount = 0;
    let warningCount = 0;

    if (consoleResult?.success && consoleResult.data) {
      const entries = Array.isArray(consoleResult.data) ? consoleResult.data : (consoleResult.data.messages || []);
      for (const entry of entries) {
        const level = (entry.level || entry.type || "log").toLowerCase();
        const msg = {
          level,
          text: entry.text || entry.message || String(entry),
          source: entry.source || entry.url || "",
          line: entry.lineNumber || entry.line || 0,
        };
        messages.push(msg);
        if (level === "error") errorCount++;
        if (level === "warning" || level === "warn") warningCount++;
      }
    }

    const failMessages = messages.filter(m => {
      const lvl = m.level === "warn" ? "warning" : m.level;
      return failLevels.includes(lvl);
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          clean: failMessages.length === 0,
          messages,
          error_count: errorCount,
          warning_count: warningCount,
          monitored_ms: duration,
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "dev_link_check",
  "Check all links on a page for broken URLs (404, 500, timeout). Extracts all anchor hrefs, tests each one, and reports broken links. With depth=1, follows internal links and checks those pages too.",
  {
    url: z.string().optional().describe("URL to check (uses current page if omitted)"),
    depth: z.number().optional().describe("0 = current page only, 1 = follow internal links one level (default 0)"),
  },
  async ({ url, depth }) => {
    const maxDepth = depth || 0;

    if (url) {
      await sendCommand("navigate", { url }, 30000);
      await sendCommand("wait_for_load", { timeoutMs: 15000 }, 17000);
    }

    // Get the current page URL for determining internal links
    const tabInfo = await sendCommand("get_active_tab_info");
    const baseUrl = tabInfo?.data?.url || url || "";
    let baseOrigin = "";
    try { baseOrigin = new URL(baseUrl).origin; } catch {}

    // Extract all links from the page
    const linksResult = await sendCommand("execute_js", { code: `
      (() => {
        const links = [];
        const seen = new Set();
        document.querySelectorAll('a[href]').forEach(a => {
          try {
            const href = new URL(a.href, location.href).href;
            if (!seen.has(href) && (href.startsWith('http://') || href.startsWith('https://'))) {
              seen.add(href);
              links.push({ url: href, text: (a.textContent || '').trim().slice(0, 80) });
            }
          } catch {}
        });
        return JSON.stringify(links);
      })()
    ` });

    if (!linksResult?.success) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Could not extract links" }) }], isError: true };
    }

    const allLinks = JSON.parse(linksResult.data);
    const broken = [];
    let working = 0;
    let externalSkipped = 0;

    // Check each link using fetch
    const checkLink = async (linkUrl, sourcePage) => {
      try {
        const checkResult = await sendCommand("execute_js", { code: `
          fetch(${JSON.stringify(linkUrl)}, { method: 'HEAD', mode: 'no-cors', signal: AbortSignal.timeout(8000) })
            .then(r => JSON.stringify({ status: r.status, ok: r.ok, type: r.type }))
            .catch(e => JSON.stringify({ error: e.message }))
        ` }, 15000);

        if (checkResult?.success) {
          const resp = JSON.parse(checkResult.data);
          if (resp.type === "opaque") {
            // no-cors response, consider it working
            working++;
          } else if (resp.error) {
            broken.push({ url: linkUrl, status: 0, error: resp.error, source_page: sourcePage });
          } else if (resp.status >= 400) {
            broken.push({ url: linkUrl, status: resp.status, source_page: sourcePage });
          } else {
            working++;
          }
        } else {
          broken.push({ url: linkUrl, status: 0, error: "check failed", source_page: sourcePage });
        }
      } catch (e) {
        broken.push({ url: linkUrl, status: 0, error: e.message, source_page: sourcePage });
      }
    };

    // Check links on the current page (limit to 50 to avoid timeout)
    const linksToCheck = allLinks.slice(0, 50);
    for (const link of linksToCheck) {
      await checkLink(link.url, baseUrl);
    }

    // Depth=1: follow internal links and check their links
    if (maxDepth >= 1) {
      const internalLinks = allLinks
        .filter(l => baseOrigin && l.url.startsWith(baseOrigin))
        .slice(0, 10); // limit to 10 internal pages

      for (const intLink of internalLinks) {
        try {
          await sendCommand("navigate", { url: intLink.url }, 15000);
          await sendCommand("wait_for_load", { timeoutMs: 10000 }, 12000);

          const subLinksResult = await sendCommand("execute_js", { code: `
            (() => {
              const links = [];
              const seen = new Set();
              document.querySelectorAll('a[href]').forEach(a => {
                try {
                  const href = new URL(a.href, location.href).href;
                  if (!seen.has(href) && (href.startsWith('http://') || href.startsWith('https://'))) {
                    seen.add(href);
                    links.push({ url: href });
                  }
                } catch {}
              });
              return JSON.stringify(links.slice(0, 20));
            })()
          ` });

          if (subLinksResult?.success) {
            const subLinks = JSON.parse(subLinksResult.data);
            for (const sub of subLinks) {
              await checkLink(sub.url, intLink.url);
            }
          }
        } catch {}
      }

      // Navigate back to original page
      if (baseUrl) {
        await sendCommand("navigate", { url: baseUrl }, 15000).catch(() => {});
      }
    }

    externalSkipped = allLinks.length > 50 ? allLinks.length - 50 : 0;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total_links: allLinks.length,
          checked: linksToCheck.length,
          broken,
          working,
          external_skipped: externalSkipped,
        }, null, 2)
      }]
    };
  }
);

server.tool(
  "dev_screenshot_diff",
  "Visual regression testing: capture a baseline screenshot or compare the current view against a saved baseline. Reports pixel-level match percentage and diff regions.",
  {
    name: z.string().describe("Identifier for this baseline (e.g. 'homepage', 'login-form')"),
    action: z.enum(["capture", "compare"]).describe("'capture' to save a new baseline, 'compare' to diff against it"),
  },
  async ({ name, action }) => {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const baselinePath = join(BASELINES_DIR, `${safeName}.json`);

    if (action === "capture") {
      // Take a screenshot and save as baseline
      const ssResult = await sendCommand("take_screenshot");
      if (!ssResult?.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Screenshot failed" }) }], isError: true };
      }

      const base64 = ssResult.data.replace(/^data:image\/png;base64,/, "");

      // Ensure baselines directory exists
      if (!existsSync(BASELINES_DIR)) {
        mkdirSync(BASELINES_DIR, { recursive: true });
      }

      // Save baseline data (base64 + dimensions)
      const dimResult = await sendCommand("execute_js", { code: `JSON.stringify({ width: window.innerWidth, height: window.innerHeight })` });
      const dims = dimResult?.success ? JSON.parse(dimResult.data) : { width: 0, height: 0 };

      writeFileSync(baselinePath, JSON.stringify({
        name: safeName,
        captured_at: new Date().toISOString(),
        width: dims.width,
        height: dims.height,
        data: base64,
      }));

      return {
        content: [
          { type: "text", text: JSON.stringify({ action: "capture", name: safeName, saved: true, path: baselinePath, dimensions: dims }, null, 2) },
          { type: "image", data: base64, mimeType: "image/png" },
        ]
      };
    }

    if (action === "compare") {
      // Load baseline
      if (!existsSync(baselinePath)) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `No baseline found for "${safeName}". Run with action "capture" first.` }) }], isError: true };
      }

      const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));

      // Take a new screenshot
      const ssResult = await sendCommand("take_screenshot");
      if (!ssResult?.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Screenshot failed" }) }], isError: true };
      }

      const currentBase64 = ssResult.data.replace(/^data:image\/png;base64,/, "");

      // Compare via canvas in the browser (pixel-level diff)
      const diffResult = await sendCommand("execute_js", { code: `
        (async () => {
          const loadImage = (src) => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
          });

          const baseline = await loadImage('data:image/png;base64,${baseline.data}');
          const current = await loadImage('data:image/png;base64,${currentBase64}');

          const w = Math.max(baseline.width, current.width);
          const h = Math.max(baseline.height, current.height);

          const c1 = document.createElement('canvas');
          c1.width = w; c1.height = h;
          const ctx1 = c1.getContext('2d');
          ctx1.drawImage(baseline, 0, 0);
          const d1 = ctx1.getImageData(0, 0, w, h);

          const c2 = document.createElement('canvas');
          c2.width = w; c2.height = h;
          const ctx2 = c2.getContext('2d');
          ctx2.drawImage(current, 0, 0);
          const d2 = ctx2.getImageData(0, 0, w, h);

          let totalPixels = w * h;
          let diffPixels = 0;
          const regionSize = 50;
          const regionDiffs = {};

          for (let i = 0; i < d1.data.length; i += 4) {
            const pixelIdx = i / 4;
            const dr = Math.abs(d1.data[i] - d2.data[i]);
            const dg = Math.abs(d1.data[i+1] - d2.data[i+1]);
            const db = Math.abs(d1.data[i+2] - d2.data[i+2]);
            if (dr + dg + db > 30) {
              diffPixels++;
              const px = pixelIdx % w;
              const py = Math.floor(pixelIdx / w);
              const rk = Math.floor(px / regionSize) + ',' + Math.floor(py / regionSize);
              regionDiffs[rk] = (regionDiffs[rk] || 0) + 1;
            }
          }

          const matchPct = Math.round((1 - diffPixels / totalPixels) * 10000) / 100;
          const regions = Object.entries(regionDiffs)
            .filter(([, count]) => count > 10)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([key, count]) => {
              const [rx, ry] = key.split(',').map(Number);
              return { x: rx * regionSize, y: ry * regionSize, w: regionSize, h: regionSize, diff_pixels: count };
            });

          return JSON.stringify({
            match_percentage: matchPct,
            diff_pixels: diffPixels,
            total_pixels: totalPixels,
            baseline_size: { w: baseline.width, h: baseline.height },
            current_size: { w: current.width, h: current.height },
            diff_regions: regions,
          });
        })()
      ` }, 30000);

      if (!diffResult?.success) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "Diff comparison failed: " + (diffResult?.error || "unknown") }) }], isError: true };
      }

      const diff = JSON.parse(diffResult.data);

      return {
        content: [
          { type: "text", text: JSON.stringify({
            action: "compare",
            name: safeName,
            match_percentage: diff.match_percentage,
            diff_pixels: diff.diff_pixels,
            total_pixels: diff.total_pixels,
            baseline_size: diff.baseline_size,
            current_size: diff.current_size,
            baseline_captured_at: baseline.captured_at,
            diff_regions: diff.diff_regions,
          }, null, 2) },
          { type: "image", data: currentBase64, mimeType: "image/png" },
        ]
      };
    }
  }
);

// ── FormFlows Tools ──

server.tool(
  "form_detect",
  "Deep-analyze all forms on the page. For each form, detects field names/types/labels/required status, select options, radio groups, checkboxes, file uploads, submit buttons, validation rules (pattern, min/max, minlength), hidden fields, and form action/method. Use before form_fill_smart to understand the form structure.",
  {
    selector: z.string().optional().describe("CSS selector to scope detection to a specific form or container"),
  },
  async ({ selector }) =>
    formatResult(await sendCommand("form_detect", { selector }, 20000))
);

server.tool(
  "form_fill_smart",
  "Intelligently map data keys to form fields and fill them. Fuzzy matching handles common variations: 'fname' = 'first_name' = 'firstName' = 'First Name'. Fills text inputs, selects dropdowns by matching option text, checks/unchecks checkboxes, selects radio buttons. Does NOT submit the form. React/Vue/Angular compatible.",
  {
    data: z.record(z.any()).describe("Key/value pairs to fill — keys are matched against field names, IDs, labels, placeholders, and aria-labels"),
    form_selector: z.string().optional().describe("CSS selector for a specific form (default: entire page)"),
    match_strategy: z.enum(["exact", "fuzzy"]).optional().describe("Matching strategy: 'exact' matches by field name/id only, 'fuzzy' (default) also matches by label text, placeholder, aria-label, and common aliases"),
  },
  async ({ data, form_selector, match_strategy }) =>
    formatResult(await sendCommand("form_fill_smart", { data, form_selector, match_strategy }, 20000))
);

server.tool(
  "form_wizard",
  "Handle multi-step forms and wizard flows end-to-end. Detects current step fields, fills matching data, clicks Next/Continue, waits for the next step, and repeats. Does NOT submit the final step. Returns a summary of all steps completed and fields filled.",
  {
    data: z.record(z.any()).describe("All data for the entire wizard — fields are matched to each step as it appears"),
    max_steps: z.number().optional().describe("Maximum steps to process before stopping (default 10)"),
  },
  async ({ data, max_steps }) => {
    const maxSteps = max_steps || 10;
    const steps = [];
    let totalFieldsFilled = 0;

    for (let step = 1; step <= maxSteps; step++) {
      // Detect current step's fields
      let detection;
      try {
        detection = await sendCommand("form_detect", {}, 15000);
      } catch (e) {
        break;
      }
      if (!detection.success || !detection.data?.forms?.length) break;

      const form = detection.data.forms[0];
      const visibleFields = form.fields.filter(f => !f.hidden);

      // If no visible fields, the wizard may be done
      if (visibleFields.length === 0) break;

      // Fill matching fields from data
      let fillResult;
      try {
        fillResult = await sendCommand("form_fill_smart", {
          data,
          form_selector: form.selector || undefined,
          match_strategy: "fuzzy",
        }, 15000);
      } catch (e) {
        steps.push({ step_number: step, fields_filled: 0, error: e.message });
        break;
      }

      const fieldsFilled = fillResult.success ? (fillResult.data?.filled?.length || 0) : 0;
      totalFieldsFilled += fieldsFilled;

      // Look for the Next / Continue / step-advance button (NOT Submit)
      const nextButtonPatterns = [
        'button:not([type="submit"])',
        '[role="button"]',
        'a.next', 'a.btn',
      ];

      // Check if submit button text indicates "Next" / "Continue" rather than final submit
      let nextButtonSelector = null;
      let nextButtonClicked = false;

      // First, look at the form's submit button — is it a "Next" style button?
      if (form.submit_selector) {
        try {
          const btnCheck = await sendCommand("get_element_attributes", { selector: form.submit_selector }, 5000);
          if (btnCheck.success) {
            const btnText = (btnCheck.data?.text || "").toLowerCase();
            if (/next|continue|proceed|go\s*to|step\s*\d|forward|>>|right/i.test(btnText) && !/submit|finish|complete|done|create|register|sign\s*up|place\s*order|pay/i.test(btnText)) {
              nextButtonSelector = form.submit_selector;
            }
          }
        } catch (e) { /* ignore */ }
      }

      // If no obvious next button from submit, search for one
      if (!nextButtonSelector) {
        try {
          const elements = await sendCommand("find_elements", {
            text: "next|continue|proceed|forward",
            limit: 5,
          }, 5000);
          if (elements.success && elements.data?.elements?.length > 0) {
            for (const el of elements.data.elements) {
              const t = (el.text || "").toLowerCase();
              if (/next|continue|proceed|forward/i.test(t) && el.visible) {
                nextButtonSelector = el.selector || (el.tag === "button" ? `button` : null);
                break;
              }
            }
          }
        } catch (e) { /* ignore */ }
      }

      // If we found a next button, click it
      if (nextButtonSelector) {
        try {
          await sendCommand("click_element", { selector: nextButtonSelector }, 5000);
          nextButtonClicked = true;
          // Wait for next step to load
          await new Promise(r => setTimeout(r, 1500));
          // Try waiting for DOM changes
          try {
            await sendCommand("wait_for_load", { timeoutMs: 5000 }, 7000);
          } catch (e) { /* page may not navigate, just DOM update */ }
        } catch (e) { /* ignore click failure */ }
      }

      steps.push({
        step_number: step,
        fields_filled: fieldsFilled,
        filled_details: fillResult.success ? fillResult.data?.filled : [],
        next_button_clicked: nextButtonClicked,
        next_button_selector: nextButtonSelector,
      });

      // If we didn't find or click a next button, this is the final step
      if (!nextButtonClicked) break;
    }

    const result = {
      steps_completed: steps.length,
      total_fields_filled: totalFieldsFilled,
      steps,
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "form_validate",
  "Trigger client-side validation on a form without submitting. Reports which fields pass/fail validation and what the error messages are, including both native constraint validation and visible error messages in the DOM.",
  {
    form_selector: z.string().optional().describe("CSS selector for the form to validate (default: first form on page)"),
  },
  async ({ form_selector }) =>
    formatResult(await sendCommand("form_validate", { form_selector }, 15000))
);

server.tool(
  "form_submit",
  "Submit a form by clicking its submit button or calling form.submit(). Optionally waits for page navigation after submit. Detects success (navigation to new URL, success messages) or failure (error messages, staying on same page).",
  {
    form_selector: z.string().optional().describe("CSS selector for the form to submit (default: first form on page)"),
    wait_for_navigation: z.boolean().optional().describe("Wait for page load after submit (default true)"),
  },
  async ({ form_selector, wait_for_navigation }) => {
    const shouldWait = wait_for_navigation !== false;

    // Get current URL before submit
    let preUrl = "";
    try {
      const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
      if (tabInfo.success) preUrl = tabInfo.data.url;
    } catch (e) { /* ignore */ }

    // First, try to detect and click the submit button via form_detect
    let submitSelector = null;
    try {
      const detection = await sendCommand("form_detect", { selector: form_selector }, 10000);
      if (detection.success && detection.data?.forms?.length > 0) {
        submitSelector = detection.data.forms[0].submit_selector;
      }
    } catch (e) { /* ignore */ }

    let submitted = false;

    // Try clicking the submit button
    if (submitSelector) {
      try {
        const clickResult = await sendCommand("click_element", { selector: submitSelector }, 5000);
        if (clickResult.success) submitted = true;
      } catch (e) { /* fall through to form.submit() */ }
    }

    // Fallback: call form.submit() via JS
    if (!submitted) {
      try {
        const formSel = form_selector || "form";
        const jsResult = await sendCommand("execute_js", {
          code: `(function() {
            var f = document.querySelector('${formSel.replace(/'/g, "\\'")}');
            if (!f) return 'no_form';
            f.submit();
            return 'submitted';
          })()`,
        }, 5000);
        if (jsResult.success && jsResult.data === "submitted") submitted = true;
        else if (jsResult.data === "no_form") {
          return { content: [{ type: "text", text: JSON.stringify({ submitted: false, error: "No form found" + (form_selector ? ": " + form_selector : "") }) }], isError: true };
        }
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ submitted: false, error: e.message }) }], isError: true };
      }
    }

    if (!submitted) {
      return { content: [{ type: "text", text: JSON.stringify({ submitted: false, error: "Could not submit form" }) }], isError: true };
    }

    // Wait for navigation / response
    if (shouldWait) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        await sendCommand("wait_for_load", { timeoutMs: 10000 }, 12000);
      } catch (e) { /* timeout is ok — page may not navigate */ }
    }

    // Check post-submit state
    let postUrl = "";
    try {
      const tabInfo = await sendCommand("get_active_tab_info", {}, 5000);
      if (tabInfo.success) postUrl = tabInfo.data.url;
    } catch (e) { /* ignore */ }

    const navigated = postUrl !== preUrl && postUrl !== "";

    // Check for success messages or error messages on the page
    let resultType = navigated ? "navigated" : "same_page";
    let errors = [];

    if (!navigated) {
      // Look for error messages
      try {
        const validationResult = await sendCommand("form_validate", { form_selector }, 10000);
        if (validationResult.success && validationResult.data) {
          if (validationResult.data.errors?.length > 0) {
            resultType = "error";
            errors = validationResult.data.errors;
          }
          if (validationResult.data.visible_errors?.length > 0) {
            resultType = "error";
            errors = errors.concat(validationResult.data.visible_errors.map(msg => ({ field: null, message: msg })));
          }
        }
      } catch (e) { /* ignore */ }

      // Look for success messages
      if (resultType !== "error") {
        try {
          const successCheck = await sendCommand("find_elements", {
            text: "success|thank you|submitted|confirmed|received|complete",
            limit: 3,
          }, 5000);
          if (successCheck.success && successCheck.data?.elements?.length > 0) {
            resultType = "success_message";
          }
        } catch (e) { /* ignore */ }
      }
    }

    const result = {
      submitted: true,
      result: resultType,
      ...(navigated ? { new_url: postUrl } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    };

    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

server.tool(
  "form_autofill_profile",
  "Retrieve a stored form-fill profile from macOS Keychain and use it to smart-fill a form. Profiles are JSON objects stored as the password value under the profile name. Use form_save_profile to create profiles first.",
  {
    profile_name: z.string().describe("Keychain service key for the stored profile (e.g. 'formflow-personal', 'formflow-work')"),
    form_selector: z.string().optional().describe("CSS selector for a specific form (default: entire page)"),
  },
  async ({ profile_name, form_selector }) => {
    // Retrieve profile from Keychain
    let profileJson;
    try {
      profileJson = await execSecurity(["find-generic-password", "-s", profile_name, "-w"]);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: No profile found in Keychain for '${profile_name}'` }], isError: true };
    }

    let profileData;
    try {
      profileData = JSON.parse(profileJson);
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Profile '${profile_name}' is not valid JSON: ${e.message}` }], isError: true };
    }

    // Use form_fill_smart to fill the form
    const fillResult = await sendCommand("form_fill_smart", {
      data: profileData,
      form_selector,
      match_strategy: "fuzzy",
    }, 20000);

    return formatResult(fillResult);
  }
);

server.tool(
  "form_save_profile",
  "Save a form-fill profile to macOS Keychain for reuse with form_autofill_profile. Profiles contain structured data like name, email, phone, address, etc. stored as JSON.",
  {
    profile_name: z.string().describe("Keychain service key to store the profile under (e.g. 'formflow-personal', 'formflow-work')"),
    data: z.record(z.any()).describe("Profile data object — e.g. { first_name: 'John', last_name: 'Doe', email: 'john@example.com', phone: '555-1234' }"),
  },
  async ({ profile_name, data }) => {
    const jsonStr = JSON.stringify(data);
    try {
      await execSecurity([
        "add-generic-password",
        "-a", "formflow-profile",
        "-s", profile_name,
        "-w", jsonStr,
        "-U",
      ]);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            profile_name,
            fields_count: Object.keys(data).length,
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: Failed to save profile '${profile_name}'` }], isError: true };
    }
  }
);

server.tool(
  "form_extract_data",
  "Extract all current values from a filled form — the inverse of form_fill. Reads every field's current value including text inputs, selects, checkboxes, radio buttons, and contenteditable elements.",
  {
    form_selector: z.string().optional().describe("CSS selector for the form to extract from (default: first form on page)"),
  },
  async ({ form_selector }) =>
    formatResult(await sendCommand("form_extract_data", { form_selector }, 15000))
);

// ── Phase 1: Core Interaction Tools ──

server.tool(
  "browser_right_click",
  "Right-click an element or coordinates to trigger context menu events. Works with custom web app context menus.",
  {
    selector: z.string().optional().describe("CSS selector for the element to right-click"),
    x: z.number().optional().describe("X coordinate (if no selector)"),
    y: z.number().optional().describe("Y coordinate (if no selector)"),
  },
  async ({ selector, x, y }) => formatResult(await sendCommand("right_click", { selector, x, y }))
);

server.tool(
  "browser_middle_click",
  "Middle-click an element or coordinates. On links, this opens the link in a new background tab.",
  {
    selector: z.string().optional().describe("CSS selector for the element to middle-click"),
    x: z.number().optional().describe("X coordinate (if no selector)"),
    y: z.number().optional().describe("Y coordinate (if no selector)"),
  },
  async ({ selector, x, y }) => formatResult(await sendCommand("middle_click", { selector, x, y }))
);

server.tool(
  "browser_double_click",
  "Double-click an element or coordinates via CDP. Triggers native dblclick event, useful for selecting words in text, opening items in file managers, etc.",
  {
    selector: z.string().optional().describe("CSS selector for the element to double-click"),
    x: z.number().optional().describe("X coordinate (if no selector)"),
    y: z.number().optional().describe("Y coordinate (if no selector)"),
  },
  async ({ selector, x, y }) => formatResult(await sendCommand("double_click", { selector, x, y }))
);

server.tool(
  "browser_triple_click",
  "Triple-click an element or coordinates via CDP. Selects entire paragraph/line in text fields and content-editable areas.",
  {
    selector: z.string().optional().describe("CSS selector for the element to triple-click"),
    x: z.number().optional().describe("X coordinate (if no selector)"),
    y: z.number().optional().describe("Y coordinate (if no selector)"),
  },
  async ({ selector, x, y }) => formatResult(await sendCommand("triple_click", { selector, x, y }))
);

server.tool(
  "browser_drag_and_drop",
  "Drag an element from source to target. Uses CDP mouse events for the physical drag motion and also dispatches HTML5 DragEvents (dragstart, dragenter, dragover, drop, dragend) for web apps that use the Drag and Drop API.",
  {
    sourceSelector: z.string().optional().describe("CSS selector for the element to drag"),
    targetSelector: z.string().optional().describe("CSS selector for the drop target"),
    fromX: z.number().optional().describe("Source X coordinate (alternative to sourceSelector)"),
    fromY: z.number().optional().describe("Source Y coordinate"),
    toX: z.number().optional().describe("Target X coordinate (alternative to targetSelector)"),
    toY: z.number().optional().describe("Target Y coordinate"),
    steps: z.number().optional().describe("Number of intermediate mouse move steps (default 10)"),
  },
  async ({ sourceSelector, targetSelector, fromX, fromY, toX, toY, steps }) =>
    formatResult(await sendCommand("drag_and_drop", { sourceSelector, targetSelector, fromX, fromY, toX, toY, steps }))
);

server.tool(
  "browser_select_text",
  "Select text within an element. For input/textarea elements, uses setSelectionRange. For other elements, uses the Selection API with Range objects. Supports character offset ranges.",
  {
    selector: z.string().describe("CSS selector for the element containing text to select"),
    startOffset: z.number().optional().describe("Character offset to start selection (default: select all)"),
    endOffset: z.number().optional().describe("Character offset to end selection"),
  },
  async ({ selector, startOffset, endOffset }) =>
    formatResult(await sendCommand("select_text", { selector, startOffset, endOffset }))
);

server.tool(
  "browser_get_selection",
  "Get the currently selected text on the page, along with bounding rectangle coordinates.",
  {},
  async () => formatResult(await sendCommand("get_selection"))
);

server.tool(
  "browser_touch",
  "Simulate touch gestures via CDP. Supports tap, long_press, swipe, and pinch gestures for testing mobile-responsive pages or touch-enabled web apps.",
  {
    gesture: z.enum(["tap", "long_press", "swipe", "pinch"]).describe("Type of touch gesture"),
    x: z.number().optional().describe("X coordinate for the gesture"),
    y: z.number().optional().describe("Y coordinate for the gesture"),
    toX: z.number().optional().describe("End X coordinate (for swipe)"),
    toY: z.number().optional().describe("End Y coordinate (for swipe)"),
    duration_ms: z.number().optional().describe("Duration of gesture in ms (default 300)"),
    selector: z.string().optional().describe("CSS selector (alternative to x/y)"),
  },
  async ({ gesture, x, y, toX, toY, duration_ms, selector }) =>
    formatResult(await sendCommand("touch_event", { gesture, x, y, toX, toY, duration_ms, selector }))
);

// ── Phase 2: Tab & Window Management ──

server.tool(
  "browser_pin_tab",
  "Pin or unpin a browser tab.",
  {
    tabId: z.number().optional().describe("Tab ID to pin (default: active tab)"),
    pinned: z.boolean().optional().describe("Whether to pin (true) or unpin (false). Default: true"),
  },
  async ({ tabId, pinned }) => formatResult(await sendCommand("pin_tab", { tabId, pinned }))
);

server.tool(
  "browser_mute_tab",
  "Mute or unmute a browser tab's audio.",
  {
    tabId: z.number().optional().describe("Tab ID to mute (default: active tab)"),
    muted: z.boolean().optional().describe("Whether to mute (true) or unmute (false). Default: true"),
  },
  async ({ tabId, muted }) => formatResult(await sendCommand("mute_tab", { tabId, muted }))
);

server.tool(
  "browser_duplicate_tab",
  "Duplicate a browser tab.",
  {
    tabId: z.number().optional().describe("Tab ID to duplicate (default: active tab)"),
  },
  async ({ tabId }) => formatResult(await sendCommand("duplicate_tab", { tabId }))
);

server.tool(
  "browser_group_tabs",
  "Group multiple tabs together with an optional title and color.",
  {
    tabIds: z.array(z.number()).describe("Array of tab IDs to group"),
    title: z.string().optional().describe("Group title"),
    color: z.enum(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]).optional().describe("Group color"),
  },
  async ({ tabIds, title, color }) => formatResult(await sendCommand("group_tabs", { tabIds, title, color }))
);

server.tool(
  "browser_ungroup_tab",
  "Remove tabs from their group.",
  {
    tabIds: z.array(z.number()).optional().describe("Tab IDs to ungroup (default: active tab)"),
  },
  async ({ tabIds }) => formatResult(await sendCommand("ungroup_tab", { tabIds }))
);

server.tool(
  "browser_list_tab_groups",
  "List all tab groups with their titles, colors, and states.",
  {},
  async () => formatResult(await sendCommand("list_tab_groups"))
);

server.tool(
  "browser_move_tab",
  "Move a tab to a different position or window.",
  {
    tabId: z.number().optional().describe("Tab ID to move (default: active tab)"),
    windowId: z.number().optional().describe("Target window ID"),
    index: z.number().optional().describe("Position index in the target window (-1 for end)"),
  },
  async ({ tabId, windowId, index }) => formatResult(await sendCommand("move_tab", { tabId, windowId, index }))
);

server.tool(
  "browser_create_window",
  "Create a new browser window.",
  {
    url: z.string().optional().describe("URL to open in the new window"),
    type: z.enum(["normal", "popup", "panel"]).optional().describe("Window type"),
    width: z.number().optional().describe("Window width in pixels"),
    height: z.number().optional().describe("Window height in pixels"),
    left: z.number().optional().describe("Window left position"),
    top: z.number().optional().describe("Window top position"),
    state: z.enum(["normal", "minimized", "maximized", "fullscreen"]).optional().describe("Initial window state"),
    incognito: z.boolean().optional().describe("Open in incognito mode"),
  },
  async ({ url, type, width, height, left, top, state, incognito }) =>
    formatResult(await sendCommand("create_window", { url, type, width, height, left, top, state, incognito }))
);

server.tool(
  "browser_close_window",
  "Close a browser window.",
  {
    windowId: z.number().optional().describe("Window ID to close (default: current window)"),
  },
  async ({ windowId }) => formatResult(await sendCommand("close_window", { windowId }))
);

server.tool(
  "browser_resize_window",
  "Resize, move, minimize, maximize, or fullscreen a browser window.",
  {
    windowId: z.number().optional().describe("Window ID (default: current window)"),
    width: z.number().optional().describe("New width in pixels"),
    height: z.number().optional().describe("New height in pixels"),
    left: z.number().optional().describe("New left position"),
    top: z.number().optional().describe("New top position"),
    state: z.enum(["normal", "minimized", "maximized", "fullscreen"]).optional().describe("Window state"),
  },
  async ({ windowId, width, height, left, top, state }) =>
    formatResult(await sendCommand("resize_window", { windowId, width, height, left, top, state }))
);

server.tool(
  "browser_list_windows",
  "List all browser windows with their tabs, dimensions, and states.",
  {},
  async () => formatResult(await sendCommand("list_windows"))
);

// ── Phase 3: Page Features ──

server.tool(
  "browser_reload",
  "Reload the current page. Use hard=true to bypass cache.",
  {
    hard: z.boolean().optional().describe("Bypass cache (hard reload). Default: false"),
  },
  async ({ hard }) => formatResult(await sendCommand("reload_page", { hard }))
);

server.tool(
  "browser_stop_loading",
  "Stop the current page from loading.",
  {},
  async () => formatResult(await sendCommand("stop_loading"))
);

server.tool(
  "browser_find_text",
  "Find and highlight all occurrences of text on the page. Scrolls to the first match. Highlights persist until the next find or page navigation.",
  {
    query: z.string().describe("Text to search for"),
    caseSensitive: z.boolean().optional().describe("Case-sensitive search. Default: false"),
    highlightColor: z.string().optional().describe("CSS color for highlights (default: yellow)"),
  },
  async ({ query, caseSensitive, highlightColor }) =>
    formatResult(await sendCommand("find_text", { query, caseSensitive, highlightColor }))
);

server.tool(
  "browser_zoom",
  "Get, set, or reset the page zoom level.",
  {
    level: z.number().optional().describe("Zoom level (1.0 = 100%, 1.5 = 150%, 0.5 = 50%)"),
    action: z.enum(["set", "get", "reset"]).optional().describe("Action to perform (default: set if level provided, get otherwise)"),
  },
  async ({ level, action }) => formatResult(await sendCommand("set_zoom", { level, action }))
);

server.tool(
  "browser_save_pdf",
  "Save the current page as a PDF using Chrome's print-to-PDF. Returns base64-encoded PDF data.",
  {
    landscape: z.boolean().optional().describe("Landscape orientation. Default: false"),
    printBackground: z.boolean().optional().describe("Print background graphics. Default: true"),
    scale: z.number().optional().describe("Scale factor (0.1 to 2.0). Default: 1"),
    format: z.enum(["letter", "a4", "legal"]).optional().describe("Paper format. Default: letter"),
  },
  async ({ landscape, printBackground, scale, format }) =>
    formatResult(await sendCommand("save_pdf", { landscape, printBackground, scale, format }))
);

server.tool(
  "browser_save_html",
  "Get the full HTML source of the current page including the rendered DOM.",
  {},
  async () => formatResult(await sendCommand("save_html"))
);

// ── Phase 4: Media Control ──

server.tool(
  "browser_media_control",
  "Play, pause, stop, or toggle media elements (video/audio) on the page.",
  {
    action: z.enum(["play", "pause", "stop", "toggle"]).optional().describe("Media action. Default: toggle"),
    selector: z.string().optional().describe("CSS selector for specific media element (default: first video or audio)"),
  },
  async ({ action, selector }) => formatResult(await sendCommand("media_control", { action, selector }))
);

server.tool(
  "browser_media_volume",
  "Set the volume or mute state of media elements.",
  {
    volume: z.number().optional().describe("Volume level 0.0 to 1.0"),
    muted: z.boolean().optional().describe("Mute or unmute"),
    selector: z.string().optional().describe("CSS selector for specific media element"),
  },
  async ({ volume, muted, selector }) => formatResult(await sendCommand("media_volume", { volume, muted, selector }))
);

server.tool(
  "browser_media_seek",
  "Seek to a specific time in a media element.",
  {
    time: z.number().describe("Time in seconds to seek to"),
    relative: z.boolean().optional().describe("If true, seek relative to current position (e.g. +10 or -5 seconds)"),
    selector: z.string().optional().describe("CSS selector for specific media element"),
  },
  async ({ time, relative, selector }) => formatResult(await sendCommand("media_seek", { time, relative, selector }))
);

server.tool(
  "browser_media_playback_rate",
  "Set the playback speed of media elements.",
  {
    rate: z.number().describe("Playback rate (1.0 = normal, 2.0 = double speed, 0.5 = half speed)"),
    selector: z.string().optional().describe("CSS selector for specific media element"),
  },
  async ({ rate, selector }) => formatResult(await sendCommand("media_playback_rate", { rate, selector }))
);

server.tool(
  "browser_media_pip",
  "Toggle Picture-in-Picture mode for a video element.",
  {
    action: z.enum(["enter", "exit", "toggle"]).optional().describe("PiP action. Default: toggle"),
    selector: z.string().optional().describe("CSS selector for specific video element"),
  },
  async ({ action, selector }) => formatResult(await sendCommand("media_pip", { action, selector }))
);

server.tool(
  "browser_media_state",
  "Get the state of all media elements (video/audio) on the page: duration, current time, paused, volume, playback rate, dimensions, etc.",
  {
    selector: z.string().optional().describe("CSS selector for specific media element (default: all)"),
  },
  async ({ selector }) => formatResult(await sendCommand("media_state", { selector }))
);

// ── Phase 5: Emulation & Overrides ──

server.tool(
  "browser_override_geolocation",
  "Override the browser's geolocation. Call with no parameters to clear the override.",
  {
    latitude: z.number().optional().describe("Latitude (-90 to 90)"),
    longitude: z.number().optional().describe("Longitude (-180 to 180)"),
    accuracy: z.number().optional().describe("Accuracy in meters (default: 100)"),
  },
  async ({ latitude, longitude, accuracy }) =>
    formatResult(await sendCommand("override_geolocation", { latitude, longitude, accuracy }))
);

server.tool(
  "browser_override_timezone",
  "Override the browser's timezone. Affects Date objects and Intl APIs.",
  {
    timezone: z.string().describe("IANA timezone string (e.g. 'America/New_York', 'Europe/London', 'Asia/Tokyo')"),
  },
  async ({ timezone }) => formatResult(await sendCommand("override_timezone", { timezone }))
);

server.tool(
  "browser_override_locale",
  "Override the browser's locale for Intl APIs, number/date formatting, etc.",
  {
    locale: z.string().describe("BCP 47 locale string (e.g. 'fr-FR', 'ja-JP', 'de-DE')"),
  },
  async ({ locale }) => formatResult(await sendCommand("override_locale", { locale }))
);

server.tool(
  "browser_override_user_agent",
  "Override the browser's User-Agent string.",
  {
    userAgent: z.string().describe("Full User-Agent string"),
    platform: z.string().optional().describe("Platform string (e.g. 'Linux x86_64')"),
    acceptLanguage: z.string().optional().describe("Accept-Language header value"),
  },
  async ({ userAgent, platform, acceptLanguage }) =>
    formatResult(await sendCommand("override_user_agent", { userAgent, platform, acceptLanguage }))
);

server.tool(
  "browser_override_media",
  "Override CSS media features: color scheme (dark/light mode), reduced motion preference, and forced colors.",
  {
    colorScheme: z.enum(["light", "dark", "no-preference"]).optional().describe("prefers-color-scheme value"),
    reducedMotion: z.enum(["reduce", "no-preference"]).optional().describe("prefers-reduced-motion value"),
    forcedColors: z.enum(["active", "none"]).optional().describe("forced-colors value"),
  },
  async ({ colorScheme, reducedMotion, forcedColors }) =>
    formatResult(await sendCommand("override_media", { colorScheme, reducedMotion, forcedColors }))
);

server.tool(
  "browser_override_vision",
  "Emulate vision deficiencies to test accessibility. Set type to 'none' to clear.",
  {
    type: z.enum(["none", "blurredVision", "deuteranopia", "protanopia", "tritanopia", "achromatopsia"]).describe("Vision deficiency type"),
  },
  async ({ type }) => formatResult(await sendCommand("override_vision", { type }))
);

server.tool(
  "browser_override_permission",
  "Override a browser permission for the current origin (e.g. grant geolocation, notifications, camera without prompts).",
  {
    name: z.string().describe("Permission name (e.g. 'geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read')"),
    setting: z.enum(["granted", "denied", "prompt"]).optional().describe("Permission state. Default: granted"),
  },
  async ({ name, setting }) => formatResult(await sendCommand("override_permission", { name, setting }))
);

server.tool(
  "browser_clear_overrides",
  "Clear all active emulation overrides (geolocation, timezone, locale, user-agent, media, vision, device metrics) and detach the debugger.",
  {},
  async () => formatResult(await sendCommand("clear_overrides"))
);

// ── Phase 6: Downloads ──

server.tool(
  "browser_download",
  "Trigger a file download by URL.",
  {
    url: z.string().describe("URL of the file to download"),
    filename: z.string().optional().describe("Suggested filename (relative to downloads folder)"),
    saveAs: z.boolean().optional().describe("Show save-as dialog"),
  },
  async ({ url, filename, saveAs }) => formatResult(await sendCommand("trigger_download", { url, filename, saveAs }))
);

server.tool(
  "browser_download_status",
  "Query download status. Returns recent downloads with state, progress, filename, and URL.",
  {
    limit: z.number().optional().describe("Max number of downloads to return (default: all)"),
  },
  async ({ limit }) => formatResult(await sendCommand("download_status", { limit }))
);

server.tool(
  "browser_download_control",
  "Pause, resume, cancel, or show a download.",
  {
    downloadId: z.number().describe("Download ID from browser_download or browser_download_status"),
    action: z.enum(["pause", "resume", "cancel", "show"]).describe("Action to perform"),
  },
  async ({ downloadId, action }) => formatResult(await sendCommand("download_control", { downloadId, action }))
);

// ── Phase 7: Accessibility ──

server.tool(
  "browser_accessibility_tree",
  "Get the accessibility tree of the page via Chrome DevTools Protocol. Returns roles, names, descriptions, values, and properties for each accessibility node.",
  {
    depth: z.number().optional().describe("Max tree depth to fetch (default: 3, use higher for deeper inspection)"),
  },
  async ({ depth }) => formatResult(await sendCommand("accessibility_tree", { depth }))
);

server.tool(
  "browser_accessibility_info",
  "Get detailed accessibility information for a specific element including ARIA role, name, description, and all a11y properties.",
  {
    selector: z.string().describe("CSS selector for the element to inspect"),
  },
  async ({ selector }) => formatResult(await sendCommand("accessibility_info", { selector }))
);

server.tool(
  "browser_aria_check",
  "Audit ARIA accessibility issues on the page or a specific element. Checks for missing alt text, unlabelled inputs, missing button/link labels, and invalid ARIA roles.",
  {
    selector: z.string().optional().describe("CSS selector to scope the audit (default: entire page)"),
  },
  async ({ selector }) => formatResult(await sendCommand("aria_check", { selector }))
);

// ── Phase 8: Advanced Storage ──

server.tool(
  "browser_indexeddb_list",
  "List all IndexedDB databases and their versions for the current origin.",
  {},
  async () => formatResult(await sendCommand("indexeddb_list"))
);

server.tool(
  "browser_indexeddb_query",
  "Query records from an IndexedDB object store. Returns store metadata and records.",
  {
    database: z.string().describe("Database name"),
    objectStore: z.string().describe("Object store name"),
    limit: z.number().optional().describe("Max records to return (default: 50)"),
    key: z.any().optional().describe("Specific key to look up"),
  },
  async ({ database, objectStore, limit, key }) =>
    formatResult(await sendCommand("indexeddb_query", { database, objectStore, limit, key }))
);

server.tool(
  "browser_indexeddb_clear",
  "Clear all records from an IndexedDB object store.",
  {
    database: z.string().describe("Database name"),
    objectStore: z.string().describe("Object store name"),
  },
  async ({ database, objectStore }) =>
    formatResult(await sendCommand("indexeddb_clear", { database, objectStore }))
);

server.tool(
  "browser_cache_list",
  "List all Cache Storage cache names for the current origin.",
  {},
  async () => formatResult(await sendCommand("cache_list"))
);

server.tool(
  "browser_cache_query",
  "List entries in a specific Cache Storage cache.",
  {
    cacheName: z.string().describe("Name of the cache to inspect"),
    limit: z.number().optional().describe("Max entries to return (default: 50)"),
  },
  async ({ cacheName, limit }) =>
    formatResult(await sendCommand("cache_query", { cacheName, limit }))
);

server.tool(
  "browser_cache_clear",
  "Delete an entire Cache Storage cache by name.",
  {
    cacheName: z.string().describe("Name of the cache to delete"),
  },
  async ({ cacheName }) => formatResult(await sendCommand("cache_clear", { cacheName }))
);

// ── Phase 9: Service Workers ──

server.tool(
  "browser_list_service_workers",
  "List all registered service workers for the current page with their scope, state, and script URL.",
  {},
  async () => formatResult(await sendCommand("list_service_workers"))
);

server.tool(
  "browser_unregister_service_worker",
  "Unregister service workers. Optionally filter by scope.",
  {
    scope: z.string().optional().describe("Scope URL to filter (default: unregister all)"),
  },
  async ({ scope }) => formatResult(await sendCommand("unregister_service_worker", { scope }))
);

server.tool(
  "browser_update_service_worker",
  "Force update check on service workers.",
  {
    scope: z.string().optional().describe("Scope URL to filter (default: update all)"),
  },
  async ({ scope }) => formatResult(await sendCommand("update_service_worker", { scope }))
);

// ── Phase 10: WebSocket Monitoring ──

server.tool(
  "browser_websocket_monitor",
  "Monitor WebSocket traffic for a specified duration. Captures connection creation, frames sent/received, and connection closures via CDP Network domain.",
  {
    duration_ms: z.number().optional().describe("How long to monitor in ms (default: 5000)"),
    urlFilter: z.string().optional().describe("Only capture frames from WebSocket URLs containing this string"),
  },
  async ({ duration_ms, urlFilter }) =>
    formatResult(await sendCommand("websocket_monitor", { duration_ms, urlFilter }, (duration_ms || 5000) + 5000))
);

server.tool(
  "browser_websocket_list",
  "List active WebSocket connections on the page (requires prior websocket_monitor call to start tracking).",
  {},
  async () => formatResult(await sendCommand("websocket_list"))
);

// ── Phase 11: Bookmarks & History ──

server.tool(
  "browser_bookmark_add",
  "Add a bookmark. If no URL provided, bookmarks the current page.",
  {
    url: z.string().optional().describe("URL to bookmark (default: current page)"),
    title: z.string().optional().describe("Bookmark title (default: page title)"),
    parentId: z.string().optional().describe("Parent folder ID"),
  },
  async ({ url, title, parentId }) => formatResult(await sendCommand("bookmark_add", { url, title, parentId }))
);

server.tool(
  "browser_bookmark_remove",
  "Remove a bookmark by ID.",
  {
    id: z.string().describe("Bookmark ID to remove"),
  },
  async ({ id }) => formatResult(await sendCommand("bookmark_remove", { id }))
);

server.tool(
  "browser_bookmark_search",
  "Search bookmarks by title, URL, or query string.",
  {
    query: z.string().describe("Search query (matches against title and URL)"),
  },
  async ({ query }) => formatResult(await sendCommand("bookmark_search", { query }))
);

server.tool(
  "browser_history_search",
  "Search browsing history by text query.",
  {
    query: z.string().describe("Search text (matches against title and URL)"),
    maxResults: z.number().optional().describe("Max results to return (default: 50)"),
    startTime: z.number().optional().describe("Only return visits after this timestamp (ms since epoch)"),
  },
  async ({ query, maxResults, startTime }) =>
    formatResult(await sendCommand("history_search", { query, maxResults, startTime }))
);

server.tool(
  "browser_history_recent",
  "Get the most recently visited pages.",
  {
    maxResults: z.number().optional().describe("Max results to return (default: 20)"),
  },
  async ({ maxResults }) => formatResult(await sendCommand("history_recent", { maxResults }))
);

// ── Phase 12: CSS & Animation Control ──

server.tool(
  "browser_animation_control",
  "List, pause, resume, cancel, or adjust playback speed of CSS animations and Web Animations on the page.",
  {
    action: z.enum(["list", "pause", "resume", "play", "cancel", "finish"]).optional().describe("Action to perform (default: list)"),
    playbackRate: z.number().optional().describe("Set playback rate (1.0 = normal, 0.5 = half speed, 2.0 = double)"),
    selector: z.string().optional().describe("CSS selector to scope to specific element's animations"),
  },
  async ({ action, playbackRate, selector }) =>
    formatResult(await sendCommand("animation_control", { action, playbackRate, selector }))
);

// ── Phase 13: Focus Management ──

server.tool(
  "browser_focus",
  "Focus or blur a specific element on the page.",
  {
    selector: z.string().describe("CSS selector for the element to focus"),
    action: z.enum(["focus", "blur"]).optional().describe("Whether to focus or blur. Default: focus"),
  },
  async ({ selector, action }) => formatResult(await sendCommand("focus_element", { selector, action }))
);

server.tool(
  "browser_tab_focus",
  "Press the Tab key to cycle through focusable elements. Use reverse=true for Shift+Tab.",
  {
    count: z.number().optional().describe("Number of Tab presses (default: 1)"),
    reverse: z.boolean().optional().describe("Shift+Tab to go backward (default: false)"),
  },
  async ({ count, reverse }) => formatResult(await sendCommand("tab_focus", { count, reverse }))
);

server.tool(
  "browser_get_focused",
  "Get information about the currently focused element on the page.",
  {},
  async () => formatResult(await sendCommand("get_focused_element"))
);

// ── Phase 14: Notifications & Dialogs ──

server.tool(
  "browser_dialog_handle",
  "Handle native JavaScript dialogs (alert, confirm, prompt) via CDP. Unlike browser_close_dialogs which handles DOM dialogs, this handles native browser dialogs that block script execution.",
  {
    action: z.enum(["read", "accept", "dismiss"]).optional().describe("Action: read (just inspect), accept, or dismiss. Default: read"),
    promptText: z.string().optional().describe("Text to enter for prompt() dialogs"),
    timeout_ms: z.number().optional().describe("How long to wait for a dialog to appear (default: 5000)"),
  },
  async ({ action, promptText, timeout_ms }) =>
    formatResult(await sendCommand("dialog_handle", { action, promptText, timeout_ms }, (timeout_ms || 5000) + 5000))
);

server.tool(
  "browser_notification_monitor",
  "Monitor for browser Notification API calls for a specified duration. Intercepts the Notification constructor to capture title, body, and icon.",
  {
    duration_ms: z.number().optional().describe("How long to monitor in ms (default: 5000)"),
  },
  async ({ duration_ms }) =>
    formatResult(await sendCommand("notification_monitor", { duration_ms }, (duration_ms || 5000) + 5000))
);

// --- Agentic messaging layer ---

const workflows = new WorkflowEngine(sendCommand, sessionState);
registerAgentTools(server, { eventBus, subscriptions, workflows, sessionState, sendCommand });

// --- Inter-agent network ---

const messageBus = new MessageBus();
const agentRegistry = new AgentRegistry(messageBus);
const sharedStateStore = new SharedStateStore(messageBus);
const taskQueue = new TaskQueue(messageBus, agentRegistry);
const agentFactory = new AgentFactory({ registry: agentRegistry, messageBus, taskQueue });

workflows.setMessageBus(messageBus);

let _localAgentId = null;
const localAgentId = () => _localAgentId;

const localAgent = agentRegistry.register({
  name: "local",
  type: "claude-code",
  capabilities: ["browse", "automate", "scrape", "analyze"],
  metadata: { version: "2.0.0", role: "browser" },
  transport: "local",
});
_localAgentId = localAgent.id;

messageBus.registerDelivery(_localAgentId, () => {});

registerNetworkTools(server, {
  registry: agentRegistry,
  messageBus,
  sharedState: sharedStateStore,
  taskQueue,
  agentFactory,
  localAgentId,
  sendCommand,
});

const agentTransport = new AgentTransport({
  registry: agentRegistry,
  messageBus,
  sharedState: sharedStateStore,
  taskQueue,
  sendCommand,
});
agentTransport.start();

// Bridge browser events to the inter-agent network so all agents see navigation, tab, console events
eventBus._networkBridge = (eventType, data) => {
  messageBus.broadcast("system", `browser.${eventType}`, data);
};
const _origPush = eventBus.push.bind(eventBus);
eventBus.push = function(eventType, data) {
  _origPush(eventType, data);
  if (this._networkBridge) this._networkBridge(eventType, data);
};

// --- Video recording, editing, extraction ---
registerVideoTools(server, {
  sendCommand,
  sessionState,
  videoChunkBuffers,
  videoDir: join(homedir(), ".browser-control", "videos"),
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `[MCP] Browser control server running, WebSocket on port ${WS_PORT}\n`
);
