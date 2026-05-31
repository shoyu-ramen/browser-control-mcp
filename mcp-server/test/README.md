# Clean-core verification harness

Offline, dependency-light regression tests (Node's built-in `node:test`) that
enforce **precedent #1 (clean core)** and **precedent #3 (verify, don't trust)**
against the MCP server's *live* tool surface and *published* artifacts.

## Run

```bash
cd mcp-server
npm test
```

Exit code is non-zero on any failure (CI / pre-submission gating). No browser,
extension, or network is needed; nothing binds port 7225.

## What it checks

| File | Assertion |
|------|-----------|
| `guard.test.js` | The **live** registered tool surface (obtained via a real `tools/list` request) exposes **only** `browser_`/`devtools_`/`keyboard_`/`dev_` tools; **zero** sensitive-family tools register; `browser_fill_password` (the historical escaped-guard leak) is locked out **by name**; no tool name embeds a sensitive token (e.g. `password`, `oauth`, `captcha`) even behind a safe prefix; the `BLOCKED_TOOL` guard wrapper is still present in `server.js` and still rejects every blocked family. Tool count is pinned **exactly** to the locked clean-core number (`EXPECTED_TOOL_COUNT`, currently 139) **and** held under a one-way ceiling — an accidental add fails loudly. |
| `pack.test.js` | `npm pack --dry-run` file list contains no sensitive modules and stays within the clean-core allowlist; the `dist/` extension zip contains exactly the expected 11 entries with no sensitive module files; the zip's `background.js` is **byte-identical** to `extension/background.js` (catches a stale published artifact); the shipped `.js` files **define/invoke no sensitive handlers** (definition/invocation-level scan — the findings.md P0 — not a naive keyword grep, so it ignores the `BLOCKED_TOOL` regex literal, the policy comment, and the author email); `.credentials` is never packaged or git-tracked. |
| `readme.test.js` | Every tool documented in the top-level `README.md` maps to a live registered handler (no doc drift) and is within the safe-core prefixes. |
| `extension.test.js` | The extension JS — both on disk (`extension/*.js`) and **inside the published `dist/` zip** — defines/dispatches no sensitive command handlers (`case "fill_password":`, `cmd<Sensitive>` defs/calls). Catches the exact bug class already hit once: a sensitive handler living **inside a kept file** (not as a separate module), which the file-list and byte-identity checks alone would miss if it were re-introduced and the zip rebuilt. |

## How it stays honest

- It reads the **live registration** (a genuine MCP `tools/list` response), not a
  static scrape and not hard-coded line numbers — so it tracks `server.js` as the
  backend trims it, and a re-added blocked tool fails the suite immediately.
- The expected safe prefixes, blocked-family probes, and sensitive name tokens
  live in `fixtures.mjs` as an **independent source of truth** (derived from
  `.jury/precedent.md`), so weakening `server.js`'s own guard regex still fails
  the tests.

## How it runs offline

`register-loader.mjs` installs an ESM loader (`loader.mjs`) that redirects two
side-effecting imports to stubs:

- `ws` → `stubs/ws.mjs` (no TCP port bind)
- `@modelcontextprotocol/sdk/server/stdio.js` → `stubs/stdio.mjs`

The **real** `McpServer` and its tool registry load unchanged. The stub stdio
transport, once `server.connect()` wires it, drives a real
`initialize → tools/list` handshake in-process and publishes the result via
`live-registry.mjs`, which `introspect.mjs` reads. This is the exact path a real
MCP client hits — faithful, but with no sockets, no subprocess, and no real
stdio.

Requires Node >= 18.19 (for `module.register`). On older Node, run with
`node --loader ./test/loader.mjs --test test/*.test.js` instead.
