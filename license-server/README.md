# Browser Control — License & Revenue Service

Phase 0 of the revenue plan (`../REVENUE-PLAN.md`, Workstream A). A small,
**zero-dependency** Node service that turns billing events into a traceable revenue
funnel.

## What it does

- Ingests **LemonSqueezy webhooks** (HMAC-verified) → append-only event log.
- Exposes **`/metrics`** (JSON) and a **`/dashboard`** rendering the revenue funnel.
- Serves the **license-validation proxy** (`/v1/licenses/{activate,validate,deactivate}`)
  — Phase-1 wired: the extension validates through here. Every response carries a
  derived **entitlement** `{tier: "pro"|"free", seats, grace_until}`; `grace_until`
  is the bounded offline window (default 72h, `LICENSE_GRACE_HOURS`) that replaces
  the old trust-cache-forever client behavior. Activations and validations are
  recorded as billing events (validations daily-deduped per hashed key ref) — the
  revenue-leakage check (distinct validated keys vs licenses issued) in `/metrics`.

## Privacy boundary (read this)

This service handles **billing and licensing data only** — orders, refunds, license
keys, amounts, timestamps. It **never** receives browsing data, page content, or
per-feature usage from the extension. The published privacy copy discloses that the
license key is sent for validation; with Phase-1 wiring that flow is **extension →
this service → LemonSqueezy** (the raw key is forwarded upstream, never persisted
here — events store a one-way SHA-256 ref). The privacy policy and Chrome Web Store
data-use disclosure must name this service alongside the payment provider — that
copy update ships with the Phase-1 extension change, before first store submission.

- The **Free→Paid** denominator (active free installs) comes from **Chrome Web Store
  stats**, entered via `POST /admin/store-stats` — **not** from a client install-ping.
  A client ping would be new data collection requiring a privacy-policy + Web Store
  disclosure update; we deliberately don't do it.
- If in-product usage telemetry is ever wanted, that is a **separate, opt-in, disclosed
  decision** — out of scope here.

## Run locally

```bash
cd license-server
# Node >= 20.6:
node --env-file=.env server.js
# Or export the vars (see .env.example) and:  npm start
```

Verify end-to-end with synthetic, correctly-signed webhooks:

```bash
LEMONSQUEEZY_SIGNING_SECRET=test_secret ADMIN_TOKEN=dev npm start &   # terminal 1
PORT=8787 LEMONSQUEEZY_SIGNING_SECRET=test_secret npm run simulate    # terminal 2
curl -s -H 'Authorization: Bearer dev' http://localhost:8787/metrics
open 'http://localhost:8787/dashboard?token=dev'
```

Run the tests:

```bash
npm test
```

## Configuration

See `.env.example`. `LEMONSQUEEZY_SIGNING_SECRET` and `ADMIN_TOKEN` are both
**fail-closed**: without the secret, webhooks are rejected; without the admin token,
`/metrics`, `/dashboard`, and `/admin/*` are disabled. `LICENSE_GRACE_HOURS`
(default 72) bounds how long clients may trust a validated entitlement offline.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | — | liveness |
| POST | `/webhooks/lemonsqueezy` | HMAC `X-Signature` | ingest billing events |
| GET | `/metrics` | Bearer admin | revenue funnel JSON |
| GET | `/dashboard` | `?token=` admin | one-page dashboard |
| POST | `/admin/store-stats` | Bearer admin | set Web Store install counts |
| POST | `/v1/licenses/{activate,validate,deactivate}` | — | LS proxy + entitlement `{tier, seats, grace_until}` |

## Deploy (gated — hand back to the owner)

Not deployed by this change. When ready:

1. Provision a service (e.g. **Railway**) and a **persistent volume** mounted at
   `DATA_DIR` (the file store is ephemeral otherwise). For higher volume, swap
   `lib/store.js` internals for Postgres.
2. Set `LEMONSQUEEZY_SIGNING_SECRET`, `ADMIN_TOKEN` (long random), and a domain.
3. In LemonSqueezy → **Webhooks**, add the `/webhooks/lemonsqueezy` URL with the same
   signing secret; subscribe to `order_created`, `order_refunded`,
   `license_key_created`, `license_key_updated`.
4. Backfill historical orders if desired (LS API, needs `LEMONSQUEEZY_API_KEY`).

## Phase 1 wiring (client side)

The server side is live (entitlement + event recording, above). The client side —
`extension/license.js` pointing at `/v1/licenses/*` instead of LemonSqueezy
directly — ships with the freemium extension change. It touches the shipped
extension and the data-flow disclosure, so the outward-facing pieces (privacy
copy, store data-use disclosure) run through the `LAUNCH.md` runbook before
release.

> ⚠️ LemonSqueezy payload field names in `lib/lemonsqueezy.js` reflect the documented
> schema at build time and are parsed defensively. Re-verify against current LS docs
> before pointing real traffic at this.
