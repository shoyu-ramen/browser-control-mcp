// Extended tools (Phases 1-14): right-click & advanced interaction, tab &
// window management, page features, media control, emulation & overrides,
// accessibility, advanced storage, service workers, WebSocket monitoring,
// CSS/animation control, focus management, notifications & dialogs.
import { z } from "zod";
import { server } from "../lib/mcp.js";
import { sendCommand, formatResult } from "../lib/runtime.js";

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

