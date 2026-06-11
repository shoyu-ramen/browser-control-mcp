# Browser Control — Revenue-Focused Development Plan

_Last updated: 2026-06-03_

This plan prioritizes all future work by its impact on revenue performance metrics.
Two decisions are locked in (confirmed with the product owner):

1. **Metrics scope — billing-side only.** Revenue metrics are derived entirely from
   LemonSqueezy (webhooks/API) + license-server events. **No browsing or usage data
   ever leaves the user's machine.** The published privacy policy
   (`marketing/privacy-policy.md`, `site/privacy.html`) and the Chrome Web Store
   data-use disclosure ("no data collected; only the license key goes to the payment
   provider") **stay true as written** — this plan does not change them.
2. **Trial → free tier.** The 7-day time-limited trial is replaced with a permanent
   **free tier** (freemium); paid unlocks the Pro surface. This keeps a top-of-funnel
   instead of a hard expiry.

## Standing guardrails (non-negotiable)

- **Clean-core freeze holds.** No work re-adds the stripped CAPTCHA/Gmail/OAuth/
  credential/network-factory tooling. The shipped MCP tool surface stays frozen; any
  `server.js` refactor must preserve it exactly and pass `cd mcp-server && npm test`.
- **Macro/profile feature stays deferred** to its gated v2.2 sprint (encrypted
  profiles, behind security gates). It appears here only as a *future SKU* — listing
  is not authorizing.
- **Outward-facing changes are gated** through the launch runbook in `LAUNCH.md`
  (public copy, store listing, pricing, anything user-visible).

---

## 1. The revenue metrics we optimize (the yardstick)

All derived billing-side. Every initiative below names the metric it moves.

| Metric | Definition | Billing-side source | Primary lever |
|---|---|---|---|
| **Net revenue** (north star) | Gross sales − refunds | LS `order_created` − `order_refunded` | everything |
| **Free→Paid conversion** | Paid licenses ÷ active free installs | LS orders ÷ Web Store install stats | freemium (F1/D) |
| **ARPU / ARPA** | Net revenue ÷ buyers (or accounts) | LS orders + seat counts | multi-seat (F3) |
| **Refund rate** | Refunds ÷ orders | LS `order_refunded` | onboarding, quality |
| **Activation rate** | Installs → first run → entitlement check | license-server activation events | onboarding (F4) |
| **Revenue leakage** | Pro usage running unpaid ÷ paid licenses | validate counts vs. orders | hardening (F2) |

"Exposes metrics for **traceability**" = every number resolves to a billing event with
an order/license ID. We trace the **revenue funnel**, never the user.

---

## 2. Prioritization framework

Each item carries a **primary revenue metric** and a RICE-style rank
(Reach × Impact × Confidence ÷ Effort). Master ranked backlog in §8.

---

## 3. Workstream A — Revenue tracking system (keystone, build first)

You can't prioritize by revenue metrics until you can see them, and F1/F2/F3 need a
server-side entitlement authority. One service unlocks all of it.

- **A1. License/metrics service** — signed-webhook receiver + entitlement API.
  - Ingests LemonSqueezy webhooks (`order_created`, `order_refunded`,
    `license_key_created/updated`) → append-only revenue-events store. Billing data
    only (order id, amount, timestamp, license id).
  - Becomes the license-validation proxy (activate/validate/deactivate) — captures
    activation counts **and** plugs the offline-forever leak (F2). _Built but dormant
    until Phase 1 wiring (gated)._
  - Issues entitlement (`free | pro | seats:N`) — the authority the free tier (D) and
    multi-seat (F3) read.
- **A2. Metrics endpoint + dashboard** — `/metrics` (JSON) + a one-page dashboard
  rendering the §1 funnel, each tile traceable to underlying billing events.
- **A3. Privacy boundary doc** — the service receives **no browsing data and no
  per-feature usage**. Conversion denominator comes from Web Store install stats
  (store-side), **not** a client install-ping (which would require disclosure — we
  deliberately avoid it).

**Status: implemented in `/license-server` (Phase 0).** Not deployed; see that
README for the gated deploy + wire-up steps.

---

## 4. Workstream B — Codebase analysis & refactoring pass

Findings from the survey, with the revenue tie-in:

- **B1. `server.js` is a 2,841-line monolith** (all ~138 tools inline). Split into
  domain modules behind a registry; extract `sendCommand`/`formatResult` plumbing.
  _Why revenue:_ the registry is where the free/Pro entitlement gate (F1/D) lives
  cleanly. Hard constraint: identical tool surface, green `npm test`.
- **B2. Reconcile the 138-vs-139 tool count.** GTM-final says 138; LAUNCH.md + test
  harness say 139. Resolve the true invariant before refactoring against it.
- **B3. License hardening (= F2).** `extension/license.js:100-103` returns `valid` on
  any network error → offline = unlimited Pro forever; trial start in
  `chrome.storage.local` is user-resettable. Move source of truth to the A1 service
  with short-lived signed entitlement + bounded offline grace.
- **B4. Test/regression gate.** Fold new `integration.test.js` / `messaging.test.js`
  into the gate; keep the 5-file npm allowlist assertion.

---

## 5. Workstream C — Five high-value features (ranked by revenue impact)

All clean-core-safe; none touches stripped tooling or the deferred macro feature.

- **F1 — Freemium paywall + contextual upgrade moments** _(conversion engine; pairs
  with D)._ Free tier = core read/drive tools; Pro = `devtools_*`, `dev_*` test flows,
  network capture, `save_pdf`, `extract_table`, emulation overrides, multi-window,
  frames, media. Free user invoking a Pro tool gets a friendly upgrade result.
  _Metric: Free→Paid conversion._
- **F2 — License hardening / server-side entitlement** _(= B3)._ Recovers revenue
  already leaking. Highest-confidence net-revenue gain. _Metric: revenue leakage._
- **F3 — Team / multi-seat & site licenses.** Biggest ARPU multiplier for a one-time
  product. A1 issues/counts seats. _Metric: ARPU._
- **F4 — Onboarding "first automation in 60s"** (fix the popup "Disconnected"
  dead-end). Activation feeds F1's funnel. _Metric: activation → conversion._
- **F5 — Recipe / template library.** Package existing `dev_*` tools as one-click
  recipes. Raises perceived value + pricing power; shareable → acquisition.
  _Metric: pricing power + acquisition._

**Gated future SKUs (roadmap, not in scope now):** scheduled/unattended recipe runs;
the **encrypted macro/profile feature as a paid v2.2 tier** — behind security gates
and the freeze.

---

## 6. Workstream D — Replace the 7-day trial with a free tier

Per the confirmed decision. This is the packaging side of F1.

**Code (extension):**
- `extension/license.js` — remove `TRIAL_DAYS`, `initTrial`, `trialDaysRemaining`;
  rewrite `checkAccess()` / `getLicenseStatus()` to return `free` vs `pro` instead of
  `trial` / `expired`.
- `extension/background.js:21` — remove the `initTrial()` install hook.
- `extension/popup.js:42-50` + `popup.html/css` — replace "Trial (N days left)" with
  a "Free / Pro" status + Upgrade CTA.

**Entitlement:** A1 returns `free|pro|seats`; the B1 registry gate enforces it.

**Public copy (gated):** `README.md:3,9`, `site/index.html` (3 buy links + trial
copy), `LAUNCH.md`, Chrome Web Store listing → "Free to use, Pro unlock $9.99."
Rebuild `dist/` via `build.sh`.

---

## 7. Sequencing

- **Phase 0 — Measure:** A1 + A2 + A3. _(Done — `/license-server`.)_
- **Phase 1 — Recover & convert:** B2 → B1 → B3/F2 → D/F1. Dashboard confirms
  conversion before public copy flips.
- **Phase 2 — Expand:** F3 multi-seat, F4 onboarding.
- **Phase 3 — Pricing power:** F5 recipes; then evaluate $9.99→$14.99 and gated SKUs
  against live ARPU/conversion data.

---

## 8. Master prioritized backlog (by revenue impact)

| Rank | Item | Primary metric | Phase | Effort |
|---|---|---|---|---|
| 1 | A1/A2 License-metrics service + dashboard | enables all | 0 | M ✅ |
| 2 | F2/B3 License hardening (plug leakage) | leakage → net rev | 1 | M |
| 3 | D/F1 Freemium split + upgrade moments | Free→Paid | 1 | M |
| 4 | F3 Multi-seat / site licenses | ARPU | 2 | M |
| 5 | F4 Onboarding (fix Disconnected) | activation→conv | 2 | S–M |
| 6 | B1 `server.js` modular refactor (gate seam) | velocity/enabler | 1 | L |
| 7 | F5 Recipe library | pricing power | 3 | M |
| 8 | B2 Reconcile 138/139 count | traceability | 1 | S |
| 9 | B4 Test gate | protects freeze | 1 | S |
| — | Future SKUs (scheduled runs, macro v2.2) | expansion | gated | — |

## 9. Honest constraints

- Local MCP tools are inherently **soft to gate** — server-validated entitlement (A1)
  is the practical enforcement bar, same model used today. No stronger guarantee is
  assumed.
- "Measure then change" is baked into Phase 1: the public trial→free-tier copy flip is
  backed by dashboard numbers, not a guess.
- Field mappings for LemonSqueezy payloads are coded defensively and should be
  re-verified against current LS docs before production traffic.
