// Sends synthetic, correctly-signed LemonSqueezy webhooks to a running server so you
// can verify ingest → metrics end-to-end without a real LemonSqueezy event.
//
//   PORT=8787 LEMONSQUEEZY_SIGNING_SECRET=test_secret node scripts/simulate-webhook.mjs
//
// Uses the same signing secret the server is configured with.

import crypto from "node:crypto";

const PORT = process.env.PORT || "8787";
const SECRET = process.env.LEMONSQUEEZY_SIGNING_SECRET || "";
const BASE = `http://localhost:${PORT}`;

if (!SECRET) {
  console.error("Set LEMONSQUEEZY_SIGNING_SECRET to the same value the server uses.");
  process.exit(1);
}

function order(id, total, status = "paid") {
  return {
    meta: { event_name: status === "refunded" ? "order_refunded" : "order_created" },
    data: {
      type: "orders",
      id,
      attributes: {
        identifier: `ord_${id}`,
        order_number: 1000 + Number(id),
        user_email: `buyer${id}@example.com`,
        currency: "USD",
        total,
        status,
        refunded_amount: status === "refunded" ? total : 0,
        created_at: new Date().toISOString(),
      },
    },
  };
}

function licenseKey(id, orderId) {
  return {
    meta: { event_name: "license_key_created" },
    data: {
      type: "license-keys",
      id,
      attributes: {
        order_id: orderId,
        status: "active",
        activation_limit: 1,
        instances_count: 1,
        created_at: new Date().toISOString(),
      },
    },
  };
}

async function post(payload) {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const res = await fetch(`${BASE}/webhooks/lemonsqueezy`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": sig },
    body,
  });
  console.log(payload.meta.event_name, "→", res.status, await res.text());
}

// Two paid orders + their license keys, then one refund. Net = one paid order.
await post(order("1", 999));
await post(licenseKey("11", "ord_1"));
await post(order("2", 999));
await post(licenseKey("12", "ord_2"));
await post(order("2", 999, "refunded"));

console.log("\nDone. Check:  curl -s -H 'Authorization: Bearer $ADMIN_TOKEN' " + BASE + "/metrics");
