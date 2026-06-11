// Pure aggregation: events (+ store-side install stats) -> the §1 revenue funnel.
// Everything here is billing-side. No browsing or per-feature usage data exists.

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function computeMetrics(events, storeStats = {}) {
  const orders = events.filter((e) => e.kind === "order");
  const refunds = events.filter((e) => e.kind === "refund");
  const licenses = events.filter((e) => e.kind === "license");

  const grossCents = orders.reduce((s, e) => s + (e.amount_cents || 0), 0);
  const refundedCents = refunds.reduce((s, e) => s + (e.refunded_amount_cents || 0), 0);
  const netCents = grossCents - refundedCents;
  const currency = orders[0]?.currency || "USD";

  const ordersCount = orders.length;
  const refundsCount = refunds.length;
  const refundRate = ordersCount ? round4(refundsCount / ordersCount) : 0;

  // Collapse license events to the latest state per license_id.
  const latestById = new Map();
  for (const l of licenses) {
    const prev = latestById.get(l.license_id);
    if (!prev || (l.occurred_at || "") >= (prev.occurred_at || "")) {
      latestById.set(l.license_id, l);
    }
  }
  const licensesIssued = latestById.size;
  const activeLicenses = [...latestById.values()].filter(
    (l) => (l.status || "active") === "active"
  ).length;
  const activeInstances = [...latestById.values()].reduce(
    (s, l) => s + (l.instances_count || 0),
    0
  );

  const buyers = new Set(orders.map((o) => o.order_id)).size;
  const arpuCents = buyers ? Math.round(netCents / buyers) : 0;

  const storeInstalls = storeStats?.installs ?? null;
  const freeToPaid = storeInstalls ? round4(ordersCount / storeInstalls) : null;

  const recordedTimes = events.map((e) => e.recorded_at).filter(Boolean).sort();

  // Proxy-side license actions (Phase 1). Validations are daily-deduped per
  // hashed key ref at ingest, so distinct_validated_keys ≈ installs actually
  // running with a key — the revenue-leakage check against licenses issued.
  const actions = events.filter((e) => e.kind === "license_action");
  const validated = actions.filter((a) => a.type === "license_validated");
  const licenseProxy = {
    activations: actions.filter((a) => a.type === "license_activate").length,
    deactivations: actions.filter((a) => a.type === "license_deactivate").length,
    validation_days: validated.length,
    distinct_validated_keys: new Set(validated.map((a) => a.license_ref)).size,
    invalid_validation_days: validated.filter((a) => a.valid === false).length,
  };

  return {
    generated_at: new Date().toISOString(),
    currency,
    revenue: {
      gross_cents: grossCents,
      refunds_cents: refundedCents,
      net_cents: netCents,
    },
    orders: {
      count: ordersCount,
      refunds_count: refundsCount,
      refund_rate: refundRate,
    },
    licenses: {
      issued: licensesIssued,
      active: activeLicenses,
      active_instances: activeInstances,
    },
    license_proxy: licenseProxy,
    funnel: {
      store_installs: storeInstalls,
      paid_orders: ordersCount,
      free_to_paid_rate: freeToPaid,
      free_to_paid_note: storeInstalls
        ? null
        : "Set store_installs via POST /admin/store-stats (Web Store stats) to compute conversion.",
    },
    arpu_cents: arpuCents,
    traceability: {
      event_count: events.length,
      first_event_at: recordedTimes[0] || null,
      last_event_at: recordedTimes[recordedTimes.length - 1] || null,
    },
  };
}
