// Best-effort mapping of LemonSqueezy webhook payloads to our billing-event shape.
// Field names follow LemonSqueezy's documented webhook schema as of build time;
// extraction is defensive (tolerant of missing fields). Re-verify against current
// LS docs before production traffic. Amounts are in cents.

function numberOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function normalizeEvent(payload) {
  const eventName = payload?.meta?.event_name;
  const data = payload?.data;
  if (!eventName || !data) return null;
  const attr = data.attributes || {};

  const base = {
    type: eventName,
    source: "lemonsqueezy",
    ls_id: data.id != null ? String(data.id) : null,
    ls_type: data.type || null,
    occurred_at: attr.created_at || attr.updated_at || null,
  };

  switch (eventName) {
    case "order_created": {
      const orderId = attr.identifier || String(data.id);
      return {
        ...base,
        kind: "order",
        // Semantic dedupe: an order is created once. Idempotent across webhook
        // retries even if the payload bytes differ — protects revenue accuracy.
        dedupe_key: `order_created:${orderId}`,
        order_id: orderId,
        order_number: attr.order_number ?? null,
        email: attr.user_email || null,
        currency: attr.currency || "USD",
        amount_cents: numberOr(attr.total, 0),
        status: attr.status || "paid",
      };
    }
    case "order_refunded": {
      const orderId = attr.identifier || String(data.id);
      return {
        ...base,
        kind: "refund",
        dedupe_key: `order_refunded:${orderId}`,
        order_id: orderId,
        order_number: attr.order_number ?? null,
        email: attr.user_email || null,
        currency: attr.currency || "USD",
        amount_cents: numberOr(attr.total, 0),
        refunded_amount_cents: numberOr(attr.refunded_amount, attr.total || 0),
        status: "refunded",
      };
    }
    case "license_key_created":
      return {
        ...base,
        kind: "license",
        dedupe_key: `license_key_created:${data.id}`,
        license_id: String(data.id),
        order_id: attr.order_id != null ? String(attr.order_id) : null,
        status: attr.status || "active",
        activation_limit: attr.activation_limit ?? null,
        instances_count: numberOr(attr.instances_count, 0),
      };
    case "license_key_updated":
      // No dedupe: each update is a real state change. Metrics collapse to the
      // latest state per license_id, so recording every update is safe.
      return {
        ...base,
        kind: "license",
        dedupe_key: null,
        license_id: String(data.id),
        order_id: attr.order_id != null ? String(attr.order_id) : null,
        status: attr.status || "active",
        activation_limit: attr.activation_limit ?? null,
        instances_count: numberOr(attr.instances_count, 0),
      };
    default:
      // Logged raw so nothing is silently dropped, but not counted in metrics.
      return { ...base, kind: "other", dedupe_key: null };
  }
}

// Phase-1 wired: the extension validates through this proxy, so activations are
// captured server-side and the offline-forever leak is closed (clients get a
// bounded grace window instead of trust-cache-forever). License endpoints are
// public upstream (no API key needed). fetchImpl is injectable for tests.
export async function forwardLicenseAction(action, body, fetchImpl = fetch) {
  const url = `https://api.lemonsqueezy.com/v1/licenses/${action}`;
  try {
    const resp = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json = await resp.json().catch(() => ({}));
    return { status: resp.status, json };
  } catch (e) {
    // Upstream unreachable. 502 tells the client "not a verdict on your key" —
    // its cached entitlement + grace window decide what happens next.
    return { status: 502, json: { error: "license upstream unreachable", detail: String((e && e.message) || e) } };
  }
}

// ── Entitlement (the single authority clients read) ─────────────────────────
// Derived from LemonSqueezy's response; forward-compatible with multi-seat.
// LS quirk handled here so clients never need to know it: validate answers with
// `valid`, activate answers with `activated` (and not always `valid`).
//
//   tier        "pro" | "free"
//   seats       activation_limit for a valid key (null limit = unlimited), 0 free
//   grace_until ISO timestamp until which a client may trust this entitlement
//               offline; past it, the client degrades to the free tier.
export function deriveEntitlement(action, status, json, opts = {}) {
  const now = opts.now ?? Date.now();
  const graceHours = opts.graceHours ?? 72;

  if (action === "deactivate") {
    return { tier: "free", seats: 0, grace_until: null };
  }

  const ok =
    status < 400 &&
    (json?.valid === true || (action === "activate" && json?.activated === true));

  if (!ok) return { tier: "free", seats: 0, grace_until: null };

  const limit = json?.license_key?.activation_limit;
  return {
    tier: "pro",
    seats: limit == null ? null : Number(limit) || 1,
    grace_until: new Date(now + graceHours * 60 * 60 * 1000).toISOString(),
  };
}
