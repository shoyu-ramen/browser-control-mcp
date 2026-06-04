# Live deployment — Railway

The Phase-0 license/revenue service is **deployed and verified** (2026-06-04).

| | |
|---|---|
| **Railway project** | `browser-control-license` (id `c8577e7b-1394-479b-9a07-7d3cfa44e1d7`) |
| **Service** | id `6e7cea65-9cab-4dbb-887d-2431310489fb` · environment `production` |
| **Public base URL** | https://browser-control-license-production.up.railway.app |
| **Volume** | mounted at `/data` (`DATA_DIR=/data`) — the append-only event log persists here |
| **Builder** | Railpack (Node from `package.json`; runs `npm start` → `node server.js`) |

## Endpoints (live)

| Path | Auth | Use |
|---|---|---|
| `GET /healthz` | — | liveness — returns `{"ok":true}` |
| `POST /webhooks/lemonsqueezy` | HMAC `X-Signature` | **point the LemonSqueezy webhook here** |
| `GET /metrics` | Bearer admin | revenue funnel JSON |
| `GET /dashboard?token=…` | admin token | one-page dashboard |
| `POST /admin/store-stats` | Bearer admin | set Web Store install counts (Free→Paid denominator) |

## Secrets

`ADMIN_TOKEN` and `LEMONSQUEEZY_SIGNING_SECRET` live in the **Railway service Variables
tab** (and were handed to the owner at deploy time). They are intentionally **not** in
git. To view/rotate: Railway → service → Variables, or `railway variables`.

## Verified at deploy

- `/healthz` ok · `/metrics` 401 without token, funnel JSON with it.
- Tampered webhook (`X-Signature: deadbeef`) → **401** (HMAC fail-closed working).
- `POST /admin/store-stats` write persisted to `/data` and read back via `/metrics`.

## Remaining to actually capture sales

1. In **LemonSqueezy → Settings → Webhooks → Add endpoint**, set the URL to
   `…/webhooks/lemonsqueezy` with the **same** signing secret as the Railway var, and
   subscribe to `order_created`, `order_refunded`, `license_key_created`,
   `license_key_updated`.
2. Re-verify the LS payload field names in `lib/lemonsqueezy.js` against current LS docs
   before real traffic.
3. Then run the sell path (`../.jury/activate-revenue.md`): G9 → confirm LS live → one
   real $9.99 purchase → the order lands here and `/dashboard` shows it.
