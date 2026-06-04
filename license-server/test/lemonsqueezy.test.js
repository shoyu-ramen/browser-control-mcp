import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent } from "../lib/lemonsqueezy.js";

test("maps order_created to a billing order event", () => {
  const evt = normalizeEvent({
    meta: { event_name: "order_created" },
    data: { type: "orders", id: "7", attributes: { identifier: "ord_7", total: 999, currency: "USD", status: "paid", user_email: "a@b.co" } },
  });
  assert.equal(evt.kind, "order");
  assert.equal(evt.order_id, "ord_7");
  assert.equal(evt.amount_cents, 999);
  assert.equal(evt.dedupe_key, "order_created:ord_7");
});

test("license_key_updated is intentionally not deduped", () => {
  const evt = normalizeEvent({
    meta: { event_name: "license_key_updated" },
    data: { type: "license-keys", id: "55", attributes: { status: "active", instances_count: 2 } },
  });
  assert.equal(evt.kind, "license");
  assert.equal(evt.dedupe_key, null);
  assert.equal(evt.instances_count, 2);
});

test("maps order_refunded with refunded amount", () => {
  const evt = normalizeEvent({
    meta: { event_name: "order_refunded" },
    data: { type: "orders", id: "7", attributes: { identifier: "ord_7", total: 999, refunded_amount: 999, status: "refunded" } },
  });
  assert.equal(evt.kind, "refund");
  assert.equal(evt.refunded_amount_cents, 999);
});

test("maps license_key_created", () => {
  const evt = normalizeEvent({
    meta: { event_name: "license_key_created" },
    data: { type: "license-keys", id: "55", attributes: { order_id: 7, status: "active", instances_count: 1 } },
  });
  assert.equal(evt.kind, "license");
  assert.equal(evt.license_id, "55");
  assert.equal(evt.order_id, "7");
  assert.equal(evt.instances_count, 1);
});

test("unknown event is kept raw, not counted", () => {
  const evt = normalizeEvent({ meta: { event_name: "subscription_created" }, data: { id: "1", attributes: {} } });
  assert.equal(evt.kind, "other");
});

test("returns null for malformed payloads", () => {
  assert.equal(normalizeEvent({}), null);
  assert.equal(normalizeEvent({ meta: { event_name: "order_created" } }), null);
});
