# Browser Control MCP

A Chrome extension + MCP server that gives Claude Code direct control of your browser. Navigate pages, fill forms, click buttons, take screenshots, monitor network traffic, manage cookies, read the clipboard, and debug visually — all from your terminal. **$9.99 one-time purchase** on the Chrome Web Store.

## Installation

### 1. Chrome Extension

Install **Claude Code Browser Control** from the [Chrome Web Store](https://chromewebstore.google.com) ($9.99).

### 2. MCP Server

```bash
npm install -g browser-control-mcp
```

### 3. Claude Code Configuration

Add the following to your Claude Code MCP config (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "npx",
      "args": ["-y", "browser-control-mcp"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "browser-control": {
      "command": "browser-control-mcp"
    }
  }
}
```

### 4. Connect

Open Chrome and start Claude Code. The extension auto-connects to the MCP server via WebSocket on `127.0.0.1:7225`.

## Tools

### Navigation
- `browser_navigate` — Go to a URL
- `browser_go_back` / `browser_go_forward` — History navigation
- `browser_wait_for_load` — Wait for page load to complete
- `browser_wait_for_element` — Wait for a CSS selector to appear

### Tab Management
- `browser_get_tab_info` — Get active tab URL and title
- `browser_list_tabs` — List all open tabs
- `browser_switch_tab` — Switch by tab ID or URL/title pattern
- `browser_new_tab` / `browser_close_tab` — Open or close tabs

### Form Interaction
- `browser_fill_field` — Fill inputs and textareas (React-compatible)
- `browser_click` — Click elements (auto-scrolls into view)
- `browser_select_option` — Select dropdown options
- `browser_get_form_fields` — List all visible form fields with selectors and labels
- `browser_press_key` — Press keys with modifier support
- `browser_hover` — Hover elements for tooltips and menus

### Page Reading
- `browser_get_text` — Get text content of any element
- `browser_execute_js` — Run arbitrary JavaScript and return results
- `browser_find_elements` — Find elements by selector or text content
- `browser_get_element_attributes` — Inspect attributes, bounds, and visibility

### Scrolling
- `browser_scroll_to` — Scroll to an element or page bottom
- `browser_scroll_by` — Scroll by direction and amount (supports reversed containers)
- `browser_get_scroll_position` — Get scroll position and at-top/at-bottom status

### Screenshots and Visual Debugging
- `browser_screenshot` — Capture the visible viewport as PNG
- `browser_highlight_element` — Highlight an element with colored overlay and label
- `browser_highlight_all` — Highlight all matches with auto-cycling colors
- `browser_clear_highlights` — Remove all highlights
- `browser_annotate_element` — Add tooltip annotations near elements

### Cookie Management
- `browser_get_cookies` / `browser_get_cookie` — Read cookies
- `browser_set_cookie` — Set cookies with full options
- `browser_delete_cookie` / `browser_clear_cookies` — Remove cookies

### Clipboard
- `browser_read_clipboard` — Read clipboard text
- `browser_write_clipboard` — Write text to clipboard
- `browser_read_clipboard_html` — Read clipboard as HTML

### Network Monitoring
- `browser_get_network_requests` — Capture all HTTP requests for a duration
- `browser_wait_for_network_request` — Wait for a request matching a URL pattern

### File Upload
- `browser_upload_file` — Upload local files to file input elements

### Viewport
- `browser_set_viewport` — Resize the browser window

### Extension Management
- `browser_status` — Check server and extension connection status
- `browser_reload_extension` — Reload the extension and wait for reconnect
- `browser_recover_extension` — Auto-recover a disconnected extension (restarts Chrome)
- `browser_wait_for_extension` — Wait for extension to connect
- `browser_open_extensions_page` — Open chrome://extensions
- `browser_close_dialogs` — Dismiss modals, popups, and overlays

## Requirements

- Google Chrome
- Node.js 18+
- Claude Code (or any MCP-compatible client)
- macOS (extension recovery features use macOS-specific APIs)

## Privacy

All communication stays local. The MCP server runs on your machine and connects to the Chrome extension via WebSocket on `127.0.0.1:7225`. No data is sent to external servers. The extension requires broad permissions (tabs, scripting, debugger, cookies, clipboard) to provide full browser control — these are only exercised in response to your explicit MCP tool calls.

## License

MIT
