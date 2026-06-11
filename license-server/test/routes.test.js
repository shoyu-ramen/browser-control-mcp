// Route-level tests: boot the real http server on an ephemeral port with a
// throwaway DATA_DIR and a stubbed global fetch (so nothing reaches the real
// LemonSqueezy API), then drive the license-proxy path a client would hit.
//
// Env must be set BEFORE importing server.js — config.js reads it at import
// time. node --test runs each file in its own process, so this is isolated.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "license-server-test-"));
process.env.DATA_DIR = dataDir;

const { server } = await import("../server.js");
const store = await import("../lib/store.js");

// Stub the upstream LS API: any /v1/licenses/<action> call answers like LS.
let upstream = () => ({ status: 200, body: { valid: true, license_key: { activation_limit: 1 } } });
globalThis.fetch = async (url) => {
  const r = upstream(url);
  return { status: r.status, json: async () => r.body };
};

let base;
before(async () => {
  await store.init();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// Real client for our server (the global stub only ever sees LS URLs, which it
// answers; our own localhost URLs go through node's http via undici… which IS
// global fetch). So: call our server with a tiny http client instead.
import http from "node:http";
function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      base + path,
      { method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") })
        );
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString() || "{}") })
      );
    }).on("error", reject);
  });
}

test("healthz is open", async () => {
  const r = await get("/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
});

test("validate attaches a pro entitlement for a valid key", async () => {
  const r = await post("/v1/licenses/validate", { license_key: "key-A" });
  assert.equal(r.status, 200);
  assert.equal(r.json.valid, true);
  assert.equal(r.json.entitlement.tier, "pro");
  assert.equal(r.json.entitlement.seats, 1);
  assert.ok(new Date(r.json.entitlement.grace_until) > new Date());
});

test("repeat validations of the same key record ONE event per day", async () => {
  const beforeCount = store.allEvents().filter((e) => e.type === "license_validated").length;
  await post("/v1/licenses/validate", { license_key: "key-A" });
  await post("/v1/licenses/validate", { license_key: "key-A" });
  const events = store.allEvents().filter((e) => e.type === "license_validated");
  // key-A already validated once in the previous test → still exactly 1 today.
  assert.equal(events.length, beforeCount === 0 ? 1 : beforeCount);
  // hashed ref only — the raw key must never be persisted
  assert.ok(events.every((e) => !JSON.stringify(e).includes("key-A")));
});

test("a different key records its own validation event, invalid keys flagged", async () => {
  upstream = () => ({ status: 200, body: { valid: false } });
  const r = await post("/v1/licenses/validate", { license_key: "key-B" });
  assert.equal(r.json.entitlement.tier, "free");
  const events = store.allEvents().filter((e) => e.type === "license_validated");
  const flagged = events.filter((e) => e.valid === false);
  assert.equal(flagged.length, 1);
});

test("upstream outage → 502 passthrough, free entitlement, NO event recorded", async () => {
  upstream = () => {
    throw new Error("boom");
  };
  const countBefore = store.allEvents().filter((e) => e.type === "license_validated").length;
  const r = await post("/v1/licenses/validate", { license_key: "key-C" });
  assert.equal(r.status, 502);
  assert.equal(r.json.entitlement.tier, "free");
  const countAfter = store.allEvents().filter((e) => e.type === "license_validated").length;
  assert.equal(countAfter, countBefore);
  upstream = () => ({ status: 200, body: { valid: true, license_key: { activation_limit: 1 } } });
});

test("activate records a license_activate event with hashed ref", async () => {
  upstream = () => ({ status: 200, body: { activated: true, license_key: { activation_limit: 1, instances_count: 1 } } });
  const r = await post("/v1/licenses/activate", { license_key: "key-D", instance_name: "test" });
  assert.equal(r.status, 200);
  assert.equal(r.json.entitlement.tier, "pro");
  const events = store.allEvents().filter((e) => e.type === "license_activate");
  assert.equal(events.length, 1);
  assert.ok(events[0].license_ref && !JSON.stringify(events[0]).includes("key-D"));
});

test("unknown route → 404", async () => {
  const r = await get("/nope");
  assert.equal(r.status, 404);
});
