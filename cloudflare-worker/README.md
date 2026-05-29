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
- It also refreshes **WHOIS/registration metadata** per domain (registered /
  expires / last changed / status) and stores it in KV (`whois:latest.json`).
- A **web dashboard** is served at `/` to view status, edit the domain list,
  trigger a run, view the WHOIS table, and download the CSV.
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

# 4. Seed the domain list — either in the dashboard at
#    https://inwx-bot.<your-subdomain>.workers.dev/  or via the API:
curl -X PUT https://inwx-bot.<your-subdomain>.workers.dev/api/domains \
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

## Dashboard

Open the Worker URL (`https://inwx-bot.<your-subdomain>.workers.dev/`) in a
browser. The page is public, but all data is gated behind the admin token:
enter your `ADMIN_TOKEN` once (kept in the browser's `sessionStorage`) to

- see the last run's status and per-domain results,
- edit and save the domain list,
- trigger a check immediately ("Jetzt prüfen"),
- view the **WHOIS / domain-status table** (registered / expires / last changed /
  status per domain; expiry within 30 days is highlighted) and refresh it,
- download the results as CSV.

A strict Content-Security-Policy (nonce-based, no external assets) is applied.

### WHOIS / domain status

Registration metadata is gathered per domain from two sources:

- **INWX `domain.info`** for domains in your own account — authoritative dates
  (registered / expires / last changed) and status, works for every TLD.
- **RDAP** (the JSON successor to WHOIS) for all other domains. Note that some
  ccTLDs — notably **.de** (DENIC) — do not publish registration/expiry over
  RDAP, so those columns may stay empty for domains you don't own.

The table refreshes on each cron run and via the "WHOIS aktualisieren" button.

## HTTP endpoints

`GET /` (dashboard) and `GET /api/status` are public. Everything else requires
`Authorization: Bearer <ADMIN_TOKEN>`.

| Method & path             | Description                                              |
|---------------------------|----------------------------------------------------------|
| `GET /`                   | Web dashboard (HTML).                                    |
| `GET /api/status`         | Health/status: dry-run mode, last run time, last error.  |
| `GET /api/domains`        | Current domain list.                                     |
| `PUT /api/domains`        | Replace the list (newline-separated text or JSON array). |
| `POST /api/run`           | Run the check now and return the result.                 |
| `POST /api/run?async=true`| Start a run in the background, return `202` immediately. |
| `GET /api/results.json`   | Full result of the last run.                             |
| `GET /api/results.csv`    | Last run as CSV (same columns as the Python script).     |
| `GET /api/whois`          | WHOIS/registration metadata per domain (last refresh).   |
| `POST /api/whois/refresh` | Refresh WHOIS data now (`?async=true` for background).    |

## Local development

```bash
cp .dev.vars.sample .dev.vars   # fill in credentials (gitignored)
npm run dev                     # wrangler dev
npm run typecheck               # tsc --noEmit
```

Tip: test against the INWX OT&E sandbox first by uncommenting `INWX_API_URL`
in `wrangler.toml`.
