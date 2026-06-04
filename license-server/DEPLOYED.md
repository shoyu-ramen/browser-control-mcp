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

## Webhook wired (2026-06-04)

LemonSqueezy webhook **created** (id `107331`, `Settings → Webhooks`):
- URL `https://browser-control-license-production.up.railway.app/webhooks/lemonsqueezy`
- Signing secret matches the Railway `LEMONSQUEEZY_SIGNING_SECRET` var.
- Events: `order_created`, `order_refunded`, `license_key_created`, `license_key_updated`.

> ⚠️ **Created in TEST MODE.** The LS store shows "Test mode: these webhooks will only
> work with test mode data" and "Your application has been received and will be
> reviewed" — the store is **not yet approved for live payments**. LS webhooks are
> **mode-specific**: this one fires only for **test-mode** orders. For live revenue you
> must (1) get the store approved by LS, (2) turn off Test mode, (3) **re-create this
> webhook in live mode** with the same URL + secret + events.

## Remaining to actually capture sales

1. **Verify the pipeline with a test-mode purchase** → confirm the order appears at
   `/metrics` and `/dashboard`. If the amount lands as `0` or is missing, adjust the
   field mapping in `lib/lemonsqueezy.js` (re-verify against current LS webhook docs).
2. **Go live (gated on LS):** store approved → Test mode off → re-create the webhook in
   live mode (see warning above).
3. Run the sell path (`../.jury/activate-revenue.md`): G9 → confirm LS live → one real
   $9.99 purchase → order lands here and `/dashboard` shows it.
