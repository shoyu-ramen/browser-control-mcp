import { test } from "node:test";
import assert from "node:assert/strict";
import { forwardLicenseAction, deriveEntitlement } from "../lib/lemonsqueezy.js";

// ── deriveEntitlement ────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 0, 1); // fixed clock for grace math

test("validate + valid:true → pro with a grace window", () => {
  const e = deriveEntitlement(
    "validate",
    200,
    { valid: true, license_key: { activation_limit: 3 } },
    { now: NOW, graceHours: 72 }
  );
  assert.equal(e.tier, "pro");
  assert.equal(e.seats, 3);
  assert.equal(e.grace_until, new Date(NOW + 72 * 3600 * 1000).toISOString());
});

test("validate + valid:false → free, no grace", () => {
  const e = deriveEntitlement("validate", 200, { valid: false }, { now: NOW });
  assert.deepEqual(e, { tier: "free", seats: 0, grace_until: null });
});

test("4xx upstream → free regardless of body", () => {
  const e = deriveEntitlement("validate", 404, { valid: true }, { now: NOW });
  assert.equal(e.tier, "free");
});

test("activate answers with `activated`, not `valid` — still pro", () => {
  // The LS quirk the proxy absorbs so clients never see it.
  const e = deriveEntitlement(
    "activate",
    200,
    { activated: true, license_key: { activation_limit: 1 } },
    { now: NOW }
  );
  assert.equal(e.tier, "pro");
  assert.equal(e.seats, 1);
});

test("`activated` is not honored for the validate action", () => {
  const e = deriveEntitlement("validate", 200, { activated: true }, { now: NOW });
  assert.equal(e.tier, "free");
});

test("null activation_limit → unlimited seats (null)", () => {
  const e = deriveEntitlement(
    "validate",
    200,
    { valid: true, license_key: { activation_limit: null } },
    { now: NOW }
  );
  assert.equal(e.seats, null);
});

test("deactivate → always free", () => {
  const e = deriveEntitlement("deactivate", 200, { deactivated: true, valid: true }, { now: NOW });
  assert.deepEqual(e, { tier: "free", seats: 0, grace_until: null });
});

// ── forwardLicenseAction ─────────────────────────────────────────────────────

test("forwards the body to the LS path for the action and returns status+json", async () => {
  const calls = [];
  const stub = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 200, json: async () => ({ valid: true }) };
  };
  const r = await forwardLicenseAction("validate", { license_key: "k-1" }, stub);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { valid: true });
  assert.equal(calls[0].url, "https://api.lemonsqueezy.com/v1/licenses/validate");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { license_key: "k-1" });
});

test("unreachable upstream → 502, never a throw", async () => {
  const stub = async () => {
    throw new Error("ECONNREFUSED");
  };
  const r = await forwardLicenseAction("validate", { license_key: "k-1" }, stub);
  assert.equal(r.status, 502);
  assert.match(r.json.error, /unreachable/);
});

test("unparseable upstream body → status with empty json", async () => {
  const stub = async () => ({
    status: 200,
    json: async () => {
      throw new Error("bad json");
    },
  });
  const r = await forwardLicenseAction("validate", {}, stub);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {});
});
