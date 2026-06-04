# Browser Control — License & Revenue Service

Phase 0 of the revenue plan (`../REVENUE-PLAN.md`, Workstream A). A small,
**zero-dependency** Node service that turns billing events into a traceable revenue
funnel.

## What it does

- Ingests **LemonSqueezy webhooks** (HMAC-verified) → append-only event log.
- Exposes **`/metrics`** (JSON) and a **`/dashboard`** rendering the revenue funnel.
- Ships a **license-validation proxy** (`/v1/licenses/{activate,validate,deactivate}`)
  that is **dormant in Phase 0** — wired to the extension in Phase 1 (gated) to capture
  activations server-side and close the offline-forever license leak.

## Privacy boundary (read this)

This service handles **billing and licensing data only** — orders, refunds, license
keys, amounts, timestamps. It **never** receives browsing data, page content, or
per-feature usage from the extension. That is what keeps the published privacy policy
("no data collected; localhost-only; only the license key goes to the payment
provider") **true as written**.

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
`/metrics`, `/dashboard`, and `/admin/*` are disabled.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | — | liveness |
| POST | `/webhooks/lemonsqueezy` | HMAC `X-Signature` | ingest billing events |
| GET | `/metrics` | Bearer admin | revenue funnel JSON |
| GET | `/dashboard` | `?token=` admin | one-page dashboard |
| POST | `/admin/store-stats` | Bearer admin | set Web Store install counts |
| POST | `/v1/licenses/{activate,validate,deactivate}` | — | LS proxy (dormant) |

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

## Phase 1 wiring (separate, gated change)

Point `extension/license.js` at `/v1/licenses/*` instead of LemonSqueezy directly so
activations are captured and entitlement (`free|pro|seats`) is server-authoritative.
This touches the shipped extension and the data-flow disclosure, so it goes through
`../.jury/go-no-go.md` before release.

> ⚠️ LemonSqueezy payload field names in `lib/lemonsqueezy.js` reflect the documented
> schema at build time and are parsed defensively. Re-verify against current LS docs
> before pointing real traffic at this.
