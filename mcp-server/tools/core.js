// Core browser tools: tab info, navigation, forms, page reading, scrolling,
// screenshots (with OS-level fallback), uploads, dialogs, keyboard/hover
// input, element inspection, history, tab management, viewport, visual
// debugging, cookies, clipboard, extension management, network log, audio,
// structured extraction, browser storage, and iframes.
import { z } from "zod";
import { server } from "../lib/mcp.js";
import {
  sendCommand,
  formatResult,
  formatScreenshot,
  WS_PORT,
  isConnected,
  getConnectionStatus,
} from "../lib/runtime.js";

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
    const { connected, extensionId, pendingRequests } = getConnectionStatus();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            server: "running",
            wsPort: WS_PORT,
            extensionConnected: connected,
            extensionId,
            pendingRequests,
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
      if (isConnected()) {
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
      if (isConnected()) {
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

