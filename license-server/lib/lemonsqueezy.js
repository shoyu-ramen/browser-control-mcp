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

// Dormant in Phase 0 (the extension still calls LemonSqueezy directly). Wired in
// Phase 1 under the go/no-go gate so activations are captured server-side and the
// offline-forever leak is closed. License endpoints are public (no API key needed).
export async function forwardLicenseAction(action, body) {
  const url = `https://api.lemonsqueezy.com/v1/licenses/${action}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}
