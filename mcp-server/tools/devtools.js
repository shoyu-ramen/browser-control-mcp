// DevTools tools: console, DOM/CSS inspection, JS evaluation, performance,
// and the other devtools_* surface.
import { z } from "zod";
import { server } from "../lib/mcp.js";
import { sendCommand, formatResult } from "../lib/runtime.js";

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

