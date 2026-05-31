// Canonical expectations for the clean-core build. These are the harness's
// INDEPENDENT source of truth (derived from .jury/precedent.md #1 and
// .jury/context.md), deliberately NOT imported from server.js — so the tests
// fail if someone widens server.js's own allowlist/blocklist toward the
// sensitive surface.

// The only tool-name prefixes the shipped build may expose.
export const SAFE_PREFIXES = ["browser_", "devtools_", "keyboard_", "dev_"];

// Clean-core ceiling: the live surface must NEVER grow past the locked count
// without an explicit, attributed, findings.md-logged ruling (precedent #5).
// Was raised 138 → 155 for the 2026-05-31 RE-LAND, then RESTORED 155 → 138 by
// team-lead's 2026-05-31 CONTAINMENT ruling (relayed via PM): the 153 re-land is
// treated as a freeze breach of the v1.0 launch tree — the macro WIP is
// UNREVIEWED/insecure and isolated to /Users/ross/bc-sprint2 (branch
// sprint-2-wip-UNREVIEWED); main is restored to the frozen clean-core 138.
export const CLEAN_CORE_MAX_TOOLS = 138;

// The LOCKED safe-core count, pinned EXACTLY so any surface change fails loudly.
// Per precedent #5, this changes ONLY via an explicit, attributed, findings.md-
// logged ruling — never to chase the live count.
//
// History (all 2026-05-30): 140 (LAUNCH.md, pre-strip) → 139 (removed the
// `browser_fill_password` leaker; handoff Decision #2) → an UNATTRIBUTED edit
// bumped this to 154 to mask a mid-gate surface expansion (reverted; that
// incident is the origin of precedent #5) → reverted back to 139 (task #19) →
// 138 (jury-security override-cluster ruling: 8 KEEP / 1 GATE
// browser_override_permission / `keyboard_record` CUT as a keylogger primitive).
// 2026-05-31: **138 → 153** — re-land ruling re-added the 15-tool macro/profile/
// dom-watch/extract feature (then later TREATED AS A FREEZE BREACH, see next).
// 2026-05-31 (CONTAINMENT): **153 → 138** — team-lead's containment ruling
// (relayed via PM) RESTORED the frozen v1.0 launch tree: the 153 re-land is a
// freeze breach of the launch build; the macro WIP is UNREVIEWED/insecure and
// has been isolated to /Users/ross/bc-sprint2 (branch sprint-2-wip-UNREVIEWED)
// for Sprint-2 rebuild behind jury-security G1-G5 + #33. main re-reverted to the
// clean-core 138 (same procedure as task #19). This is the attributed, findings-
// logged ruling precedent #5 requires — NOT a silent edit. #5/#6 re-run at 138.
export const EXPECTED_TOOL_COUNT = 138;

// Representative names from every removed/blocked family (precedent #1). Each
// MUST be rejected by the registration guard and MUST NOT appear in the live
// surface. Add a probe here whenever a new sensitive family is identified.
export const BLOCKED_PROBES = [
  // OS / system control
  "browser_os_exec",
  "browser_os_run",
  // credential / secret store (Keychain etc.)
  "credential_get",
  "credential_store",
  "api_key_store",
  "api_key_get",
  // auth / identity / account lifecycle
  "auth_detect",
  "login_auto",
  "signup_create",
  "password_reset",
  "mfa_submit",
  "sms_read",
  "id_verify_start",
  // Google / Gmail / OAuth
  "gmail_send",
  "gmail_read",
  "google_oauth_login",
  "email_read",
  // CAPTCHA solving
  "captcha_solve",
  "captcha_detect",
  // form autofill
  "form_autofill",
  "form_fill_credentials",
  // network factory / raw network exec
  "network_factory_create",
  "network_browser_exec",
  // inter-agent workflow
  "agent_dispatch",
  "agent_workflow_run",
  // video / tab recording
  "video_record_start",
  "video_capture",
  // dropped-permission browser extras
  "browser_bookmark_add",
  "browser_history_search",
  "browser_download_file",
  "browser_group_tabs",
  "browser_ungroup_tab",
  "browser_list_tab_groups",
  "browser_recover_extension",
  "browser_auto_login",
];

// A few safe names that MUST continue to register — guards against an
// over-broad blocklist that accidentally strips the core.
export const SAFE_PROBES = [
  "browser_click",
  "browser_navigate",
  "browser_screenshot",
  "browser_get_tab_info",
  "keyboard_type_text",
];

// Sensitive family TOKENS that must not appear ANYWHERE in a registered tool
// name — not just as a leading prefix. server.js's BLOCKED_TOOL guard anchors
// most families at "^" (e.g. /^password_/), so a safe-looking name like
// `browser_fill_password` slips through the guard while still driving a
// sensitive capability. Precedent #1 is about capability, not spelling, so the
// harness checks substrings. `field`/`fill` alone are intentionally NOT here —
// generic form fill (browser_fill_field) is core and allowed.
export const SENSITIVE_NAME_TOKENS = [
  "password",
  "passwd",
  "captcha",
  "gmail",
  "oauth",
  "credential",
  "api_key",
  "apikey",
  "mfa",
  "_otp",
  "totp",
  "auto_login",
  "autologin",
  "id_verify",
  "idverify",
  "signup",
  "_sms",
  "keychain",
  "autofill",
];

// Sensitive WS command tokens. A re-introduced sensitive handler in the
// shipped server source would show up as the server SENDING one of these to the
// extension — `sendCommand("<token>...")` — or as a `cmd<Name>`/`async function
// <name>` definition. We match at this DEFINITION/INVOCATION level (not a bare
// keyword grep) so the scan does NOT false-positive on the BLOCKED_TOOL regex
// literal, the policy comment, or the author's gmail address — all of which
// legitimately mention these words. This is the precise form of the findings.md
// "dead sensitive source still inline" P0 check.
export const SENSITIVE_COMMAND_TOKENS = [
  "fill_password",
  "gmail_",
  "google_oauth",
  "oauth_",
  "captcha_",
  "solve_captcha",
  "mfa_",
  "sms_",
  "id_verify",
  "verify_identity",
  "credential_",
  "get_credential",
  "api_key_",
  "keychain",
  "network_factory",
  "network_browser_exec",
  "agent_dispatch",
  "agent_workflow",
  "video_record",
  "start_recording",
  "form_autofill",
  "auto_login",
];

// Sensitive handler-function name fragments that should never be DEFINED in the
// shipped server source.
export const SENSITIVE_FUNCTION_NAMES = [
  "cmdFillPassword",
  "cmdGmail",
  "cmdOauth",
  "cmdGoogleOauth",
  "cmdCaptcha",
  "cmdSolveCaptcha",
  "cmdMfa",
  "cmdSms",
  "cmdIdVerify",
  "cmdCredential",
  "cmdApiKey",
  "networkBrowserExec",
  "agentDispatch",
];

// Sensitive substrings that must not appear in any published file name.
// Used by the npm-pack / dist-zip file-list assertions.
export const SENSITIVE_FILE_PATTERNS = [
  /agent-tools/i,
  /network-tools/i,
  /network-factory/i,
  /video-tools/i,
  /captcha/i,
  /gmail/i,
  /oauth/i,
  /credential/i,
  /\bauth\b/i,
  /\.credentials$/i,
  /keychain/i,
];
