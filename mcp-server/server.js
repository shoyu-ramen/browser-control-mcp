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
import { SessionState } from "./messaging/session-state.js";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_ID_FILE = join(__dirname, ".extension-id");

const WS_PORT = 7225;
const SERVER_VERSION = "2.1.0";
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

const server = new McpServer({
  name: "browser-control",
  version: SERVER_VERSION,
});

// Store-compliant build: expose only core browser-automation tools.
// Sensitive/OS-level/credential/auth/identity tools are not registered in this
// build and are therefore unreachable over MCP.
const _registerTool = server.tool.bind(server);
const BLOCKED_TOOL =
  /^(browser_os_|credential_|api_key_|auth_|captcha_|gmail_|google_oauth_|id_verify_|mfa_|sms_|login_|signup_|password_|email_|form_|network_|agent_|video_|browser_bookmark|browser_history|browser_download|browser_group_tabs|browser_ungroup_tab|browser_list_tab_groups|browser_recover_extension|browser_auto_login)/;
server.tool = (name, ...rest) =>
  BLOCKED_TOOL.test(name) ? undefined : _registerTool(name, ...rest);

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

async function execAsync(cmd, timeoutMs = 10000) {
  const { exec } = await import("child_process");
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
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
            content: [{ type: "text", text: "Opened chrome://extensions — check that 'Browser Control MCP' is enabled and has no errors" }],
          });
        }
      });
    });
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
  "Set permission states (granted/denied/prompt) for the active tab's origin to test your app's permission-gated flows during automated testing — equivalent to Chrome DevTools' Permissions override panel (Playwright grantPermissions parity). Covers geolocation, notifications, camera, microphone, and similar permissions, set without interrupting an automated test flow. Scoped to the current origin only. The override persists until reset — re-call with setting 'prompt' to restore the default browser prompt behavior.",
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

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(
  `[MCP] Browser control server running, WebSocket on port ${WS_PORT}\n`
);
