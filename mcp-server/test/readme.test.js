// README ↔ handler mapping test.
//
// Every tool the README advertises (backtick-wrapped browser_/devtools_/
// keyboard_/dev_ names under the Tools section) must map to a tool that is
// actually registered on the live server. Catches doc drift where the README
// promises a tool that was renamed/removed/blocked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getRegisteredTools } from "./introspect.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const README = join(here, "..", "..", "README.md");

const TOOL_TOKEN = /`((?:browser_|devtools_|keyboard_|dev_)[a-zA-Z0-9_]+)`/g;

function documentedTools() {
  const md = readFileSync(README, "utf8");
  const found = new Set();
  for (const m of md.matchAll(TOOL_TOKEN)) found.add(m[1]);
  return [...found].sort();
}

test("README: every documented tool maps to a registered handler", async () => {
  const { names } = await getRegisteredTools();
  const live = new Set(names);

  const documented = documentedTools();
  assert.ok(
    documented.length > 0,
    "expected the README to document at least one tool — did the Tools section format change?"
  );

  const missing = documented.filter((t) => !live.has(t));
  assert.deepEqual(
    missing,
    [],
    `README documents tools with no registered handler (doc drift): ${missing.join(
      ", "
    )}`
  );
});

test("README: documented tools are all within the safe-core prefixes", () => {
  // Defense-in-depth: the regex already constrains prefixes, but assert it so a
  // future README that documents, say, a credential_ tool fails here too.
  const documented = documentedTools();
  const SAFE = ["browser_", "devtools_", "keyboard_", "dev_"];
  const offenders = documented.filter((t) => !SAFE.some((p) => t.startsWith(p)));
  assert.deepEqual(
    offenders,
    [],
    `README documents tools outside the safe-core prefixes: ${offenders.join(", ")}`
  );
});
