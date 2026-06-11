// The McpServer instance + the single registration gate every tool flows
// through. All domain modules register via server.tool(...), so this wrapper
// is the one seam for surface policy (clean-core blocklist today; any future
// per-tool gating belongs here too).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_VERSION } from "./runtime.js";

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
export { server };
