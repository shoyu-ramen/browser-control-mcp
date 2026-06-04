import http from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { config, warnConfig } from "./lib/config.js";
import * as store from "./lib/store.js";
import { verifySignature } from "./lib/signature.js";
import { normalizeEvent, forwardLicenseAction } from "./lib/lemonsqueezy.js";
import { computeMetrics } from "./lib/metrics.js";

const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

function send(res, status, body, headers = {}) {
  const isHtml = typeof body === "string";
  const payload = isHtml ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": isHtml ? "text/html; charset=utf-8" : "application/json",
    ...headers,
  });
  res.end(payload);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Constant-time bearer/query-token check. Fail-closed when ADMIN_TOKEN is unset.
function adminOk(req, url) {
  if (!config.adminToken) return false;
  const header = req.headers["authorization"] || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const provided = bearer || url.searchParams.get("token") || "";
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// One-way short hash so the proxy can correlate activations without storing the
// raw license key. (Billing/licensing data only — never browsing data.)
function refOf(key) {
  return key ? crypto.createHash("sha256").update(String(key)).digest("hex").slice(0, 16) : null;
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /healthz") {
      return send(res, 200, { ok: true });
    }

    // ── LemonSqueezy webhook ingest (HMAC-verified) ──────────────────────────
    if (route === "POST /webhooks/lemonsqueezy") {
      const raw = await readRaw(req);
      if (!verifySignature(raw, req.headers["x-signature"], config.signingSecret)) {
        return send(res, 401, { error: "invalid signature" });
      }
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        return send(res, 400, { error: "invalid json" });
      }
      const evt = normalizeEvent(payload);
      if (evt?.dedupe_key && store.seenDedupe(evt.dedupe_key)) {
        return send(res, 200, { ok: true, deduped: true, type: evt.type });
      }
      if (evt) await store.appendEvent(evt);
      return send(res, 200, { ok: true, recorded: !!evt, type: payload?.meta?.event_name || null });
    }

    // ── License-validation proxy (DORMANT in Phase 0; wired in Phase 1) ───────
    if (req.method === "POST" && /^\/v1\/licenses\/(activate|validate|deactivate)$/.test(url.pathname)) {
      const action = url.pathname.split("/").pop();
      const raw = await readRaw(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return send(res, 400, { error: "invalid json" });
      }
      const result = await forwardLicenseAction(action, body);
      if (result.status < 400 && (action === "activate" || action === "deactivate")) {
        await store.appendEvent({
          kind: "license_action",
          type: `license_${action}`,
          source: "proxy",
          license_ref: refOf(body.license_key),
          instances_count: result.json?.license_key?.instances_count ?? null,
          occurred_at: new Date().toISOString(),
        });
      }
      return send(res, result.status, result.json);
    }

    // ── Metrics (admin-guarded) ──────────────────────────────────────────────
    if (route === "GET /metrics") {
      if (!adminOk(req, url)) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, computeMetrics(store.allEvents(), await store.getStoreStats()));
    }

    if (route === "GET /dashboard" || route === "GET /") {
      if (!adminOk(req, url)) return send(res, 401, "Unauthorized — append ?token=YOUR_ADMIN_TOKEN");
      const html = await fsp.readFile(path.join(PUBLIC_DIR, "dashboard.html"), "utf8");
      return send(res, 200, html);
    }

    // ── Store-side install stats (the Free→Paid denominator) ─────────────────
    if (route === "POST /admin/store-stats") {
      if (!adminOk(req, url)) return send(res, 401, { error: "unauthorized" });
      const raw = await readRaw(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return send(res, 400, { error: "invalid json" });
      }
      const saved = await store.setStoreStats({ installs: body.installs, weekly_active: body.weekly_active });
      return send(res, 200, saved);
    }

    return send(res, 404, { error: "not found", route });
  } catch (e) {
    return send(res, 500, { error: "internal", message: String((e && e.message) || e) });
  }
});

// Only listen when run directly (so tests can import lib modules without a socket).
const runDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (runDirectly) {
  await store.init();
  warnConfig();
  server.listen(config.port, () => {
    console.log(`license-server listening on :${config.port}`);
    console.log(`dashboard: http://localhost:${config.port}/dashboard?token=YOUR_ADMIN_TOKEN`);
  });
}
