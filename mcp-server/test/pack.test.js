// Published-artifact tests: the npm tarball and the packaged extension zip must
// contain no sensitive modules (precedent #1) and no leaked secret file.
//
// These shell out to `npm pack --dry-run --json` (authoritative npm file list)
// and to the dist zip's central directory, so they verify what actually ships
// rather than what the `files` array claims.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

import {
  SENSITIVE_FILE_PATTERNS,
  SENSITIVE_COMMAND_TOKENS,
  SENSITIVE_FUNCTION_NAMES,
} from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(here, "..");
const REPO_ROOT = join(SERVER_DIR, "..");
const DIST_ZIP = join(REPO_ROOT, "dist", "browser-control-mcp.zip");
const EXTENSION_DIR = join(REPO_ROOT, "extension");

// The exact set of entries the packaged extension zip must contain — no more,
// no less. Guards against a sensitive file sneaking in or a kept file dropping.
const EXPECTED_ZIP_ENTRIES = [
  "manifest.json",
  "background.js",
  "offscreen.html",
  "offscreen.js",
  "license.js",
  "popup.html",
  "popup.js",
  "popup.css",
  "icon16.png",
  "icon48.png",
  "icon128.png",
];

// Files the npm tarball is PERMITTED to contain (clean-core packaging). This is
// a superset/allowlist: a file in `files` that is NOT here fails the test; an
// entry here that isn't currently shipped is harmless. Each messaging module is
// reachable from server.js's import graph and backs a SAFE-CORE feature —
// verified benign (no child_process, no credentials, no sensitive sendCommand).
// Do NOT add the unshipped inter-agent modules (agent-registry/message-bus/
// task-queue/shared-state) — they must stay out of `files`.
//
// persistence.js + named-store.js (macro/session-profile store) were added then
// REVERTED with the 2026-05 net-new tools (task #19); kept here as permitted so
// the test doesn't churn if they return, but they are not currently shipped.
const ALLOWED_NPM_FILES = new Set([
  "package.json",
  "server.js",
  // B1 modular split: the entrypoint plus lib/ plumbing and tools/ domain
  // modules — together they register exactly the same clean-core surface the
  // monolithic server.js did (guard.test.js pins the live surface).
  "lib/mcp.js",
  "lib/runtime.js",
  "tools/core.js",
  "tools/devtools.js",
  "tools/keyboard.js",
  "tools/dev.js",
  "tools/extended.js",
  "messaging/event-bus.js",
  "messaging/subscriptions.js",
  "messaging/session-state.js",
  "messaging/persistence.js", // permitted dep (currently reverted out)
  "messaging/named-store.js", // permitted dep (currently reverted out)
  // npm always includes these if present:
  "README.md",
  "LICENSE",
  "LICENSE.md",
]);

function npmPackFileList() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: SERVER_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(out);
  return parsed[0].files.map((f) => f.path);
}

function zipEntryNames(zipPath) {
  // Prefer `unzip -Z1`, fall back to `zipinfo -1`; both print one entry name
  // per line and ship on macOS/Linux. Returns null if neither tool exists so
  // the caller can soft-skip rather than error on a minimal image.
  for (const [cmd, args] of [
    ["unzip", ["-Z1", zipPath]],
    ["zipinfo", ["-1", zipPath]],
  ]) {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8" });
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      if (err && err.code === "ENOENT") continue; // tool missing — try next
      throw err; // tool exists but failed (e.g. corrupt zip) — surface it
    }
  }
  return null;
}

function zipEntryBytes(zipPath, entry) {
  // `unzip -p` streams one entry to stdout. maxBuffer bumped for safety.
  return execFileSync("unzip", ["-p", zipPath, entry], {
    maxBuffer: 16 * 1024 * 1024,
  });
}

const flagged = (name) =>
  SENSITIVE_FILE_PATTERNS.filter((re) => re.test(name)).map(String);

test("npm pack: file list contains no sensitive modules", () => {
  const files = npmPackFileList();
  assert.ok(files.length > 0, "npm pack returned no files");

  const sensitive = files.filter((f) => flagged(f).length > 0);
  assert.deepEqual(
    sensitive,
    [],
    `npm tarball must not include sensitive modules; found: ${sensitive.join(", ")}`
  );
});

test("npm pack: file list stays within the clean-core allowlist", () => {
  const files = npmPackFileList();
  const unexpected = files.filter((f) => !ALLOWED_NPM_FILES.has(f));
  assert.deepEqual(
    unexpected,
    [],
    `npm tarball includes files outside the clean-core allowlist: ${unexpected.join(
      ", "
    )}. If this is intentional, update ALLOWED_NPM_FILES.`
  );
});

test("dist zip: extension package contains no sensitive modules", (t) => {
  if (!existsSync(DIST_ZIP)) {
    // The zip is a build artifact; from a fresh checkout it may be absent.
    // Treat as a soft skip rather than a failure so `npm test` runs anywhere.
    t.skip(`${basename(DIST_ZIP)} not present — skipping zip file-list check`);
    return;
  }
  const names = zipEntryNames(DIST_ZIP);
  if (names === null) {
    t.skip("neither unzip nor zipinfo available — skipping zip file-list check");
    return;
  }
  assert.ok(names.length > 0, "dist zip appears empty");

  const sensitive = names.filter((n) => flagged(n).length > 0);
  assert.deepEqual(
    sensitive,
    [],
    `extension zip must not include sensitive modules; found: ${sensitive.join(", ")}`
  );
});

test("dist zip: contains exactly the expected 11 entries", (t) => {
  if (!existsSync(DIST_ZIP)) {
    t.skip(`${basename(DIST_ZIP)} not present — skipping zip entry-set check`);
    return;
  }
  const names = zipEntryNames(DIST_ZIP);
  if (names === null) {
    t.skip("neither unzip nor zipinfo available — skipping zip entry-set check");
    return;
  }
  assert.deepEqual(
    names.slice().sort(),
    EXPECTED_ZIP_ENTRIES.slice().sort(),
    "dist zip entry set drifted from the expected 11-file extension package"
  );
});

test("dist zip: packaged background.js is byte-identical to extension/background.js", (t) => {
  // The zip must not go stale relative to the live extension source. If the
  // extension's background.js is edited (e.g. stripping a sensitive handler or
  // a manifest-driven change), the zip MUST be rebuilt or this fails. Catches
  // a published artifact lagging the reviewed source.
  if (!existsSync(DIST_ZIP)) {
    t.skip(`${basename(DIST_ZIP)} not present — skipping zip freshness check`);
    return;
  }
  const extFile = join(EXTENSION_DIR, "background.js");
  if (!existsSync(extFile)) {
    t.skip("extension/background.js not present — skipping zip freshness check");
    return;
  }
  let zipped;
  try {
    zipped = zipEntryBytes(DIST_ZIP, "background.js");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      t.skip("unzip not available — skipping zip freshness check");
      return;
    }
    throw err;
  }
  const onDisk = readFileSync(extFile);
  assert.ok(
    zipped.equals(onDisk),
    `dist/browser-control-mcp.zip is STALE: its background.js differs from ` +
      `extension/background.js. Rebuild the zip after editing the extension.`
  );
});

test("source cleanliness: shipped JS files define/invoke no sensitive handlers", () => {
  // The findings.md P0: dead sensitive handler source still inline in the
  // shipped server. We scan the published .js files at the DEFINITION/INVOCATION
  // level — sensitive `sendCommand("<token>...")` calls and `cmd<Name>`/function
  // definitions — NOT a bare keyword grep, so the legitimate mentions in the
  // BLOCKED_TOOL regex literal, the policy comment, and the author's gmail
  // address don't trip it.
  const jsFiles = npmPackFileList().filter((f) => f.endsWith(".js"));
  assert.ok(jsFiles.length > 0, "expected at least one shipped .js file");

  const cmdRe = new RegExp(
    "sendCommand\\(\\s*[\"'`](" +
      SENSITIVE_COMMAND_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
      ")",
    "i"
  );
  const defRe = new RegExp(
    "(?:async\\s+function|function|const|let|var)\\s+(" +
      SENSITIVE_FUNCTION_NAMES.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") +
      ")\\b",
    "i"
  );

  const offenders = [];
  for (const rel of jsFiles) {
    const src = readFileSync(join(SERVER_DIR, rel), "utf8");
    src.split("\n").forEach((line, i) => {
      if (cmdRe.test(line) || defRe.test(line)) {
        offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "shipped source contains sensitive handler definitions/invocations " +
      `(re-introduced dead sensitive code — precedent #1 / findings.md P0):\n  ${offenders.join(
        "\n  "
      )}`
  );
});

test("repo: no plaintext .credentials file is tracked or packaged", () => {
  // The npm tarball must never carry it.
  const files = npmPackFileList();
  const leaked = files.filter((f) => /(^|\/)\.credentials$/i.test(f));
  assert.deepEqual(leaked, [], `.credentials must never be packaged; found: ${leaked.join(", ")}`);

  // And it must not be git-tracked (deletion from disk is the team lead's call,
  // but it must at minimum stay untracked/gitignored).
  let tracked = "";
  try {
    tracked = execFileSync("git", ["ls-files", "--", ".credentials", "mcp-server/.credentials"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    // not a git repo / git unavailable — skip the tracked check
    return;
  }
  assert.equal(
    tracked,
    "",
    `.credentials must not be git-tracked; tracked path(s): ${tracked}`
  );
});
