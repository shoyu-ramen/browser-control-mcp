// Keyboard shortcut tools: the keyboard_* surface.
import { z } from "zod";
import { server } from "../lib/mcp.js";
import { sendCommand, formatResult } from "../lib/runtime.js";

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

