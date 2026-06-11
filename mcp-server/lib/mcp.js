// The McpServer instance + the single registration gate every tool flows
// through. All domain modules register via server.tool(...), so this wrapper
// is the one seam for surface policy: the clean-core blocklist and the
// free/Pro entitlement gate both live here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_VERSION, sendCommand } from "./runtime.js";

const server = new McpServer({
  name: "browser-control",
  version: SERVER_VERSION,
});

// ── Free/Pro entitlement gate (the monetization knob) ───────────────────────
// Free tier = the full core read/drive surface. Pro = the developer-power
// surface below. Gating wraps the HANDLER only — all 138 tools stay registered
// and visible, so a free user discovers Pro tools and hits a friendly upgrade
// moment instead of a missing tool.
//
// The extension is the entitlement holder (license + bounded offline grace in
// extension/license.js); the gate reads it via the get_license_status command
// and caches briefly. Failures fail OPEN: enforcement here is a practical bar,
// not DRM (REVENUE-PLAN "honest constraints") — a version-skewed or offline
// extension must never brick a paying user.
export const PRO_TOOL_PREFIXES = ["devtools_", "dev_"];
export const PRO_TOOLS = new Set([
  // network capture
  "browser_get_network_requests",
  "browser_wait_for_network_request",
  "browser_websocket_monitor",
  "browser_websocket_list",
  // export & extraction
  "browser_save_pdf",
  "browser_extract_table",
  // emulation & overrides
  "browser_override_geolocation",
  "browser_override_timezone",
  "browser_override_locale",
  "browser_override_user_agent",
  "browser_override_media",
  "browser_override_vision",
  "browser_override_permission",
  "browser_clear_overrides",
  // multi-window
  "browser_create_window",
  "browser_close_window",
  "browser_resize_window",
  "browser_list_windows",
  // frames
  "browser_list_frames",
  "browser_frame_content",
  "browser_frame_click",
  "browser_frame_fill",
  "browser_frame_execute_js",
  // media control
  "browser_media_control",
  "browser_media_volume",
  "browser_media_seek",
  "browser_media_playback_rate",
  "browser_media_pip",
  "browser_media_state",
]);

// Mirrors extension/license.js PURCHASE_URL (the single source of truth there).
const PURCHASE_URL =
  "https://browser-control-mcp.lemonsqueezy.com/checkout/buy/920548b5-6f48-458a-874e-7871048f334d";

export function isProTool(name) {
  return PRO_TOOL_PREFIXES.some((p) => name.startsWith(p)) || PRO_TOOLS.has(name);
}

const TIER_CACHE_MS = 60_000;
let tierCache = { tier: null, at: 0 };

export function __resetTierCacheForTests() {
  tierCache = { tier: null, at: 0 };
}

async function currentTier() {
  if (tierCache.tier && Date.now() - tierCache.at < TIER_CACHE_MS) {
    return tierCache.tier;
  }
  let tier = "pro"; // fail-open: only an explicit "free" answer gates
  try {
    const res = await sendCommand("get_license_status", {}, 3000);
    if (res && res.success && res.data && res.data.tier === "free") {
      tier = "free";
    }
  } catch {
    // Extension not connected / timed out: the gated tool's own sendCommand
    // will surface the real connectivity error — don't mask it with a paywall.
  }
  tierCache = { tier, at: Date.now() };
  return tier;
}

function upgradeResult(name) {
  return {
    content: [
      {
        type: "text",
        text:
          `"${name}" is a Pro tool — the free tier covers all core browsing & automation ` +
          `(navigate, click, fill, screenshot, tabs, cookies, storage, and more).\n\n` +
          `Pro unlocks DevTools, dev_* test flows, network capture, PDF export, ` +
          `emulation overrides, multi-window, frames, and media control — one-time $9.99:\n` +
          `${PURCHASE_URL}\n\n` +
          `Already purchased? Paste the license key into the extension popup ` +
          `(it should show "Pro"), then retry this tool. Please relay this to the user.`,
      },
    ],
    isError: true,
  };
}

function gateProHandler(name, handler) {
  return async (...args) => {
    if ((await currentTier()) === "free") return upgradeResult(name);
    return handler(...args);
  };
}

// Store-compliant build: expose only core browser-automation tools.
// Sensitive/OS-level/credential/auth/identity tools are not registered in this
// build and are therefore unreachable over MCP.
const _registerTool = server.tool.bind(server);
const BLOCKED_TOOL =
  /^(browser_os_|credential_|api_key_|auth_|captcha_|gmail_|google_oauth_|id_verify_|mfa_|sms_|login_|signup_|password_|email_|form_|network_|agent_|video_|browser_bookmark|browser_history|browser_download|browser_group_tabs|browser_ungroup_tab|browser_list_tab_groups|browser_recover_extension|browser_auto_login)/;
server.tool = (name, ...rest) => {
  if (BLOCKED_TOOL.test(name)) return undefined;
  if (isProTool(name) && typeof rest[rest.length - 1] === "function") {
    rest[rest.length - 1] = gateProHandler(name, rest[rest.length - 1]);
  }
  return _registerTool(name, ...rest);
};
export { server };
