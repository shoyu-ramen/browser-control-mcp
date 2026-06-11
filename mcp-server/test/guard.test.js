// Clean-core registration guard — regression tests (enforces precedent #1).
//
// These assert against the LIVE registered tool surface (obtained via a real
// tools/list request to the running server, see introspect.mjs) plus a static
// check that the guard wrapper itself is still in place. They fail loudly if
// anyone re-adds, re-registers, or un-blocks any sensitive tool, or weakens the
// guard regex.
//
// Run via:  npm test   (which installs the offline loader; see package.json)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getRegisteredTools } from "./introspect.mjs";
import {
  SAFE_PREFIXES,
  CLEAN_CORE_MAX_TOOLS,
  EXPECTED_TOOL_COUNT,
  BLOCKED_PROBES,
  SAFE_PROBES,
  SENSITIVE_NAME_TOKENS,
} from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// B1 modular split: the registration guard lives in lib/mcp.js (the one seam
// every server.tool(...) call flows through), so the static source checks read
// that file rather than the thin server.js entrypoint.
const REGISTRY_PATH = join(here, "..", "lib", "mcp.js");

const matchesSafePrefix = (name) => SAFE_PREFIXES.some((p) => name.startsWith(p));

test("guard: live surface exposes ONLY safe-core prefixes", async () => {
  const { names } = await getRegisteredTools();
  assert.ok(names.length > 0, "expected the server to register at least one tool");

  const offenders = names.filter((n) => !matchesSafePrefix(n));
  assert.deepEqual(
    offenders,
    [],
    `every registered tool must start with one of ${SAFE_PREFIXES.join(
      ", "
    )}; offending tools: ${offenders.join(", ")}`
  );
});

test("guard: ZERO sensitive tools register (precedent #1)", async () => {
  const { names } = await getRegisteredTools();
  const live = new Set(names);

  const leaked = BLOCKED_PROBES.filter((n) => live.has(n));
  assert.deepEqual(
    leaked,
    [],
    `blocked tools must never register; these leaked into the live surface: ${leaked.join(
      ", "
    )}`
  );
});

test("guard: browser_fill_password NEVER registers (named regression lock)", async () => {
  // This specific tool was the escaped-guard leak: its `browser_` prefix let it
  // pass the prefix-anchored BLOCKED_TOOL regex while it drove the extension's
  // sensitive `fill_password` handler. It has been removed; this test locks it
  // by NAME so a re-add is caught immediately and unambiguously at the gate.
  const { names } = await getRegisteredTools();
  const live = new Set(names);
  for (const banned of ["browser_fill_password", "browser_auto_login"]) {
    assert.equal(
      live.has(banned),
      false,
      `${banned} must NEVER register (precedent #1 escaped-guard regression)`
    );
  }
});

test("guard: no registered tool name contains a sensitive family token", async () => {
  // Stricter than the prefix-anchored BLOCKED_TOOL regex in server.js: a tool
  // such as `browser_fill_password` is browser_-prefixed (so it passes the
  // guard) yet drives a sensitive capability. Precedent #1 is about capability,
  // not spelling — flag any sensitive token anywhere in the name.
  const { names } = await getRegisteredTools();
  const offenders = names.filter((n) => {
    const lower = n.toLowerCase();
    return SENSITIVE_NAME_TOKENS.some((tok) => lower.includes(tok));
  });
  assert.deepEqual(
    offenders,
    [],
    `registered tools embed a sensitive family token (capability leak past the ` +
      `prefix-anchored guard): ${offenders.join(", ")}. ` +
      `Either rename/remove the tool or, if intentionally core, narrow the token list in fixtures.mjs.`
  );
});

test("guard: every documented safe-core tool still registers", async () => {
  const { names } = await getRegisteredTools();
  const live = new Set(names);

  const missing = SAFE_PROBES.filter((n) => !live.has(n));
  assert.deepEqual(
    missing,
    [],
    `the blocklist must not strip core tools; these expected safe tools are missing: ${missing.join(
      ", "
    )}`
  );
});

test("guard: live tool count is EXACTLY the locked clean-core number", async () => {
  // Belt-and-suspenders alongside the ceiling: pin the exact post-strip count so
  // an accidental ADD (139→140) fails loudly rather than silently sitting under
  // the ceiling. If this trips, EITHER a tool was added/removed — reconcile with
  // handoff Decision #2 and update EXPECTED_TOOL_COUNT deliberately, never just
  // to make the test pass.
  const { names } = await getRegisteredTools();
  assert.equal(
    names.length,
    EXPECTED_TOOL_COUNT,
    `live tool count ${names.length} != locked clean-core count ${EXPECTED_TOOL_COUNT}. ` +
      `A change to the registered surface must be intentional + reconciled with Decision #2 ` +
      `(and every "139 tools" doc/listing reference) before updating this pin.`
  );
});

test("guard: live tool count has not grown past the clean-core ceiling", async () => {
  const { names } = await getRegisteredTools();
  assert.ok(
    names.length <= CLEAN_CORE_MAX_TOOLS,
    `live tool count ${names.length} exceeds the clean-core ceiling ${CLEAN_CORE_MAX_TOOLS}. ` +
      `Surface may shrink but never grow toward the blocklist (precedent #1). ` +
      `If tools were intentionally removed, the surface should be SMALLER, not larger.`
  );
});

// --- Static guard-presence checks: the wrapper itself must remain ---
// lib/mcp.js is concurrently maintained; these read the live file (no
// hard-coded line numbers) and confirm the registration guard is intact and
// still rejects every blocked family, so the guard can't be silently deleted
// or weakened.

test("guard source: BLOCKED_TOOL regex exists and wraps server.tool", () => {
  const src = readFileSync(REGISTRY_PATH, "utf8");

  assert.match(
    src,
    /const\s+BLOCKED_TOOL\s*=/,
    "lib/mcp.js must define a BLOCKED_TOOL regex"
  );
  // The wrapper must short-circuit registration for blocked names.
  assert.match(
    src,
    /server\.tool\s*=\s*\([^)]*\)\s*=>\s*[\s\S]*BLOCKED_TOOL\.test/,
    "server.tool must be wrapped so BLOCKED_TOOL.test(name) gates registration"
  );
});

test("guard source: live BLOCKED_TOOL regex rejects every blocked family", () => {
  const src = readFileSync(REGISTRY_PATH, "utf8");
  const m = src.match(/const\s+BLOCKED_TOOL\s*=\s*([\s\S]*?);/);
  assert.ok(m, "could not locate the BLOCKED_TOOL regex literal in lib/mcp.js");

  // Reconstruct the actual regex literal from source and verify it still
  // matches our representative blocked names. This catches a weakened regex.
  // eslint-disable-next-line no-eval
  const re = (0, eval)("(" + m[1].trim() + ")");
  assert.ok(re instanceof RegExp, "BLOCKED_TOOL must be a RegExp");

  const notBlocked = BLOCKED_PROBES.filter((n) => !re.test(n));
  assert.deepEqual(
    notBlocked,
    [],
    `the BLOCKED_TOOL regex no longer blocks these families: ${notBlocked.join(
      ", "
    )}`
  );

  // And it must NOT block legitimate core tools.
  const wronglyBlocked = SAFE_PROBES.filter((n) => re.test(n));
  assert.deepEqual(
    wronglyBlocked,
    [],
    `the BLOCKED_TOOL regex wrongly blocks core tools: ${wronglyBlocked.join(", ")}`
  );
});
