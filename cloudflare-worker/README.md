# INWX Bot — Cloudflare Worker

A serverless variant of the [`check_domain.py`](../readme.md) bot. It runs on a
**Cron Trigger** instead of being started by hand, talks to the INWX JSON-RPC
API directly via `fetch` (the Python `requests`-based SDK does not run on
Workers), and stores the domain list and results in **Workers KV**.

## How it works

- A **Cron Trigger** invokes the Worker on a schedule (default: daily 06:00 UTC).
- It logs in to INWX, checks each domain from the KV list with `domain.check`,
  and — unless `DRY_RUN` is on — registers free ones with `domain.create`.
- Results are written to KV (`results:latest.json` and `results:latest.csv`).
- Optional: a notification is POSTed to a Slack/Discord-compatible webhook when
  something noteworthy happens (a domain is available, bought, or a run fails).

> **Safety first:** `DRY_RUN` defaults to `"true"`, so out of the box the bot
> only *reports* available domains and never spends money. Set it to `"false"`
> in `wrangler.toml` and redeploy once you are confident.

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free plan is enough).
- Node.js 18+ and the Wrangler CLI (installed locally via `npm install`).

## Setup

```bash
cd cloudflare-worker
npm install

# 1. Create the KV namespace and copy the printed id into wrangler.toml
#    (replace REPLACE_WITH_YOUR_KV_NAMESPACE_ID).
npx wrangler kv namespace create INWX_BOT

# 2. Store your credentials as secrets (not in wrangler.toml).
npx wrangler secret put INWX_USERNAME
npx wrangler secret put INWX_PASSWORD
npx wrangler secret put ADMIN_TOKEN          # bearer token for the HTTP endpoints
# Optional:
npx wrangler secret put INWX_SHARED_SECRET   # only if 2FA / mobile TAN is enabled
npx wrangler secret put NOTIFY_WEBHOOK_URL   # Slack/Discord webhook
npx wrangler secret put INWX_NS1             # default nameservers on purchase
npx wrangler secret put INWX_NS2

# 3. Deploy.
npx wrangler deploy

# 4. Seed the domain list (one per line, or a JSON array).
curl -X PUT https://inwx-bot.<your-subdomain>.workers.dev/domains \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  --data-binary $'example.de\nmy-other-domain.com'
```

You can also set the domain list without the HTTP API:

```bash
npx wrangler kv key put --binding INWX_BOT domains $'example.de\nfoo.com'
```

## Configuration

Non-secret settings live in `wrangler.toml` under `[vars]`:

| Variable        | Default                              | Description                                   |
|-----------------|--------------------------------------|-----------------------------------------------|
| `DRY_RUN`       | `"true"`                             | When true, never registers — only reports.    |
| `API_DELAY_MS`  | `"1000"`                             | Delay between API calls (rate limiting).      |
| `INWX_API_URL`  | `https://api.domrobot.com/jsonrpc/`  | Set to the OT&E URL to test against sandbox.   |

Secrets (set with `wrangler secret put`): `INWX_USERNAME`, `INWX_PASSWORD`,
`ADMIN_TOKEN`, and the optional `INWX_SHARED_SECRET`, `NOTIFY_WEBHOOK_URL`,
`INWX_NS1`, `INWX_NS2`.

The schedule is controlled by the `crons` array in `wrangler.toml`.

## HTTP endpoints

All except `GET /` require `Authorization: Bearer <ADMIN_TOKEN>`.

| Method & path        | Description                                              |
|----------------------|----------------------------------------------------------|
| `GET /`              | Health/status: last run time, domain count, last error.  |
| `GET /domains`       | Current domain list.                                     |
| `PUT /domains`       | Replace the list (newline-separated text or JSON array). |
| `POST /run`          | Run the check now and return the result.                 |
| `POST /run?async=true` | Start a run in the background, return `202` immediately. |
| `GET /results.json`  | Full result of the last run.                             |
| `GET /results.csv`   | Last run as CSV (same columns as the Python script).     |

## Local development

```bash
cp .dev.vars.sample .dev.vars   # fill in credentials (gitignored)
npm run dev                     # wrangler dev
npm run typecheck               # tsc --noEmit
```

Tip: test against the INWX OT&E sandbox first by uncommenting `INWX_API_URL`
in `wrangler.toml`.
