// Extension-artifact content scan (precedent #1 regression for the CWS package).
//
// The dist zip's file-LIST check (pack.test.js) only catches sensitive *module
// files*; the byte-identity check only catches a *stale* zip. Neither catches
// the exact bug we already hit once — a sensitive handler living INSIDE a kept
// file (extension/background.js had `case "fill_password"` + `cmdFillPassword`).
// If that were re-introduced AND the zip rebuilt, byte-identity would stay
// green while the leak shipped. So we scan the CONTENT of the extension JS — on
// disk AND inside the published zip — at the definition/invocation level:
//   - `case "<sensitive_command>":` dispatch labels
//   - `cmd<SensitiveName>` handler definitions/calls
// This mirrors the server-side source-cleanliness scan and is the regression
// guard qa-lead asked to keep in scope for the gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

import {
  SENSITIVE_COMMAND_TOKENS,
  SENSITIVE_FUNCTION_NAMES,
} from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..", "..");
const EXTENSION_DIR = join(REPO_ROOT, "extension");
const DIST_ZIP = join(REPO_ROOT, "dist", "browser-control-mcp.zip");

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// `case "fill_password":` / `case 'gmail_send':` dispatch labels.
const CASE_RE = new RegExp(
  'case\\s+["\'`](' + SENSITIVE_COMMAND_TOKENS.map(esc).join("|") + ")",
  "i"
);
// `async function cmdFillPassword(` / `const cmdGmail = ` etc.
const FN_RE = new RegExp(
  "(?:async\\s+function|function|const|let|var)\\s+(" +
    SENSITIVE_FUNCTION_NAMES.map(esc).join("|") +
    ")\\b",
  "i"
);
// Belt-and-suspenders: any cmd<...SensitiveFragment> identifier (e.g. a call
// site `cmdFillPassword(params)` even without a fresh definition).
const CMD_FRAG_RE =
  /\bcmd[A-Za-z]*?(Password|Gmail|Oauth|Captcha|Mfa|Sms|Credential|ApiKey|Autofill|AutoLogin|IdVerify)/;

const sensitiveLine = (line) =>
  CASE_RE.test(line) || FN_RE.test(line) || CMD_FRAG_RE.test(line);

function scan(label, files, readFn) {
  const offenders = [];
  for (const f of files) {
    const src = readFn(f);
    src.split("\n").forEach((line, i) => {
      if (sensitiveLine(line)) {
        offenders.push(`${label}:${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
  return offenders;
}

function zipJsEntries() {
  for (const [cmd, args] of [
    ["unzip", ["-Z1", DIST_ZIP]],
    ["zipinfo", ["-1", DIST_ZIP]],
  ]) {
    try {
      const out = execFileSync(cmd, args, { encoding: "utf8" });
      return out
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.endsWith(".js"));
    } catch (err) {
      if (err && err.code === "ENOENT") continue;
      throw err;
    }
  }
  return null;
}

test("extension source: no sensitive command handlers in extension/*.js", () => {
  if (!existsSync(EXTENSION_DIR)) {
    test.skip("extension/ not present — skipping extension source scan");
    return;
  }
  const files = readdirSync(EXTENSION_DIR).filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 0, "expected at least one extension/*.js file");

  const offenders = scan("extension", files, (f) =>
    readFileSync(join(EXTENSION_DIR, f), "utf8")
  );
  assert.deepEqual(
    offenders,
    [],
    "extension source defines/dispatches sensitive command handlers " +
      `(precedent #1 — e.g. a re-added fill_password/gmail/captcha handler):\n  ${offenders.join(
        "\n  "
      )}`
  );
});

test("dist zip: packaged extension JS contains no sensitive command handlers", () => {
  // The strongest check: scan the CONTENT of the JS actually inside the
  // published zip, so a re-introduced-then-rebuilt leak is caught.
  if (!existsSync(DIST_ZIP)) {
    test.skip(`${basename(DIST_ZIP)} not present — skipping zip content scan`);
    return;
  }
  const entries = zipJsEntries();
  if (entries === null) {
    test.skip("neither unzip nor zipinfo available — skipping zip content scan");
    return;
  }
  assert.ok(entries.length > 0, "no .js entries found inside the dist zip");

  let offenders;
  try {
    offenders = scan("zip", entries, (name) =>
      execFileSync("unzip", ["-p", DIST_ZIP, name], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      })
    );
  } catch (err) {
    if (err && err.code === "ENOENT") {
      test.skip("unzip not available — skipping zip content scan");
      return;
    }
    throw err;
  }

  assert.deepEqual(
    offenders,
    [],
    "PUBLISHED extension zip contains sensitive command handlers in its JS " +
      `(precedent #1 NO-SHIP — a sensitive handler shipped inside a kept file):\n  ${offenders.join(
        "\n  "
      )}`
  );
});
