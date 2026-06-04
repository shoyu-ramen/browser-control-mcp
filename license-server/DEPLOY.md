# Deploy — Railway (license/revenue service)

> **Gated.** This is the paste-ready deploy procedure for when the owner decides to go
> live. It does **not** deploy anything by itself. Pairs with `railway.toml` (in this
> dir) and the "Deploy (gated)" section of `README.md`. Phase-1 extension wiring is a
> **separate** gated change (`../.jury/go-no-go.md`).
>
> **Critical:** the store is **file-backed JSONL** (`lib/store.js`). A persistent
> **volume mounted at `DATA_DIR`** is mandatory — without it, every redeploy wipes all
> revenue events. Step 3 is not optional.

## What ships

Zero npm dependencies. Nixpacks builds from `package.json` `engines` (`node >=18`;
`.nvmrc` pins 20). Start command and `/healthz` health check come from `railway.toml`.

## Prerequisites

- A Railway account + the [Railway CLI](https://docs.railway.com/guides/cli)
  (`npm i -g @railway/cli`), or use the dashboard.
- The LemonSqueezy **webhook signing secret** and a long random **admin token**.

## Steps

### 1. Create the project + service

```bash
cd /Users/ross/browser-control/license-server
railway login
railway init                      # create a new project (name it e.g. browser-control-license)
railway up                        # build + deploy this dir; railway.toml is picked up
```

(Or via dashboard: **New Project → Deploy from repo / empty service**, then point the
service root at `license-server/`.)

### 2. Set service variables (fail-closed without them)

```bash
railway variables \
  --set "LEMONSQUEEZY_SIGNING_SECRET=<the LS webhook signing secret>" \
  --set "ADMIN_TOKEN=<long random string>" \
  --set "DATA_DIR=/data"
# Optional, only for historical order backfill via the LS API:
#   --set "LEMONSQUEEZY_API_KEY=<ls api key>"
```

- Without `LEMONSQUEEZY_SIGNING_SECRET` → **all webhooks rejected** (fail-closed).
- Without `ADMIN_TOKEN` → `/metrics`, `/dashboard`, `/admin/*` **disabled** (fail-closed).
- Do **not** set `PORT` — Railway injects it and the service reads `process.env.PORT`.

### 3. Attach a persistent volume at `/data`  ← mandatory

```bash
railway volume add --mount-path /data
```

(Or dashboard: **service → Settings → Volumes → New Volume**, mount path `/data`.)
This must match the `DATA_DIR=/data` variable from step 2. Redeploy after attaching so
the mount is live.

> For higher volume later, swap `lib/store.js` internals for Postgres (a Railway
> Postgres plugin + a connection string) — the volume is the Phase-0 file-store path.

### 4. Generate a public domain

```bash
railway domain                    # prints e.g. https://browser-control-license.up.railway.app
```

### 5. Verify the deploy

```bash
curl -s https://<your-domain>/healthz                       # -> {"ok":true}
curl -s -H "Authorization: Bearer <ADMIN_TOKEN>" \
     https://<your-domain>/metrics | head                   # -> funnel JSON (zeros at first)
# Dashboard in a browser:
#   https://<your-domain>/dashboard?token=<ADMIN_TOKEN>
```

### 6. Wire the LemonSqueezy webhook

In **LemonSqueezy → Settings → Webhooks → Add endpoint**:

- **URL:** `https://<your-domain>/webhooks/lemonsqueezy`
- **Signing secret:** the **same** value as `LEMONSQUEEZY_SIGNING_SECRET` (step 2).
- **Events:** `order_created`, `order_refunded`, `license_key_created`,
  `license_key_updated`.

> ⚠️ Re-verify the LemonSqueezy payload field names in `lib/lemonsqueezy.js` against
> current LS docs **before** pointing real traffic at this — they're parsed
> defensively but reflect the documented schema at build time.

### 7. (Optional) Seed the Free→Paid denominator

The conversion denominator is **Chrome Web Store install stats**, entered manually —
never a client install-ping (that would be undisclosed data collection):

```bash
curl -s -X POST -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"installs": 1234, "weekly_active": 567}' \
  https://<your-domain>/admin/store-stats
```

## Smoke-test the live deploy with a signed synthetic webhook

Before trusting real traffic, fire a correctly-signed test event at the live endpoint
(see `scripts/simulate-webhook.mjs`); confirm it appears in `/metrics`. Then send a
tampered one and confirm a `401`.

---

_Phase-1 note: only after this is live + verified do you point `extension/license.js` at
`/v1/licenses/*` (the dormant proxy). That touches the shipped extension and the
data-flow disclosure, so it goes through `../.jury/go-no-go.md` first._
