import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMetrics } from "../lib/metrics.js";

const events = [
  { kind: "order", order_id: "ord_1", amount_cents: 999, currency: "USD", recorded_at: "2026-06-01T00:00:00Z" },
  { kind: "order", order_id: "ord_2", amount_cents: 999, currency: "USD", recorded_at: "2026-06-02T00:00:00Z" },
  { kind: "refund", order_id: "ord_2", refunded_amount_cents: 999, recorded_at: "2026-06-03T00:00:00Z" },
  { kind: "license", license_id: "55", status: "active", instances_count: 1, occurred_at: "2026-06-01T00:00:00Z", recorded_at: "2026-06-01T00:00:01Z" },
  { kind: "license", license_id: "56", status: "active", instances_count: 1, occurred_at: "2026-06-02T00:00:00Z", recorded_at: "2026-06-02T00:00:01Z" },
];

test("computes gross, refunds, and net revenue", () => {
  const m = computeMetrics(events, {});
  assert.equal(m.revenue.gross_cents, 1998);
  assert.equal(m.revenue.refunds_cents, 999);
  assert.equal(m.revenue.net_cents, 999);
});

test("computes order + refund counts and rate", () => {
  const m = computeMetrics(events, {});
  assert.equal(m.orders.count, 2);
  assert.equal(m.orders.refunds_count, 1);
  assert.equal(m.orders.refund_rate, 0.5);
});

test("counts issued licenses and active instances", () => {
  const m = computeMetrics(events, {});
  assert.equal(m.licenses.issued, 2);
  assert.equal(m.licenses.active, 2);
  assert.equal(m.licenses.active_instances, 2);
});

test("free->paid is null without store installs, computed with them", () => {
  assert.equal(computeMetrics(events, {}).funnel.free_to_paid_rate, null);
  assert.equal(computeMetrics(events, { installs: 200 }).funnel.free_to_paid_rate, 0.01);
});

test("ARPU is net revenue over distinct buyers", () => {
  // net 999 / 2 distinct order_ids = ~500 cents
  assert.equal(computeMetrics(events, {}).arpu_cents, 500);
});

test("empty input does not divide by zero", () => {
  const m = computeMetrics([], {});
  assert.equal(m.revenue.net_cents, 0);
  assert.equal(m.orders.refund_rate, 0);
  assert.equal(m.arpu_cents, 0);
});
