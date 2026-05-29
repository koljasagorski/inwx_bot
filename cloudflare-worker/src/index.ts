/**
 * INWX domain bot as a Cloudflare Worker.
 *
 * - A Cron Trigger runs the check on a schedule (see wrangler.toml).
 * - The domain list and the latest results live in a KV namespace.
 * - A web dashboard is served at `/`.
 * - JSON/CSV endpoints under `/api/*` (bearer-token protected, except the
 *   public `/api/status`) let you manage the list, trigger a run, and
 *   download results.
 *
 * This mirrors the behaviour of the Python `check_domain.py` script.
 */
import { dashboardPage } from "./dashboard";
import { InwxClient, type AccountInfo } from "./inwx";

export interface Env {
  INWX_BOT: KVNamespace;
  INWX_USERNAME?: string;
  INWX_PASSWORD?: string;
  INWX_SHARED_SECRET?: string;
  INWX_API_URL?: string;
  INWX_NS1?: string;
  INWX_NS2?: string;
  ADMIN_TOKEN?: string;
  NOTIFY_WEBHOOK_URL?: string;
  API_DELAY_MS?: string;
  DRY_RUN?: string;
}

type Action = "skipped" | "purchased" | "purchase_failed" | "would_purchase" | "error";

interface DomainStatus {
  domain: string;
  available: boolean | null;
  action: Action;
  detail: string;
  api_code: number | null;
  api_msg: string | null;
}

interface RunRecord {
  timestamp: string;
  dryRun: boolean;
  statuses: DomainStatus[];
  error?: string;
}

const LIVE_API_URL = "https://api.domrobot.com/jsonrpc/";
const DOMAINS_KEY = "domains";
const RESULTS_JSON_KEY = "results:latest.json";
const RESULTS_CSV_KEY = "results:latest.csv";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isTrue = (value: string | undefined) => (value ?? "").trim().toLowerCase() === "true";

function parseDomainList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map((d) => String(d).trim()).filter(Boolean);
      }
    } catch {
      // fall through to newline parsing
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((d) => d.trim())
    .filter(Boolean);
}

async function loadDomains(env: Env): Promise<string[]> {
  const raw = await env.INWX_BOT.get(DOMAINS_KEY);
  return raw ? parseDomainList(raw) : [];
}

function toCsv(statuses: DomainStatus[]): string {
  const fields: (keyof DomainStatus)[] = ["domain", "available", "action", "detail", "api_code", "api_msg"];
  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [fields.join(",")];
  for (const status of statuses) {
    lines.push(fields.map((f) => escape(status[f])).join(","));
  }
  return lines.join("\n");
}

async function processDomain(
  client: InwxClient,
  domain: string,
  accountInfo: AccountInfo,
  ns: string[],
  dryRun: boolean,
): Promise<DomainStatus> {
  const available = await client.isDomainFree(domain);
  if (!available) {
    return {
      domain,
      available: false,
      action: "skipped",
      detail: "already registered",
      api_code: 1000,
      api_msg: "domain not available",
    };
  }
  if (dryRun) {
    return { domain, available: true, action: "would_purchase", detail: "dry run – not purchased", api_code: null, api_msg: null };
  }

  const buyParams: Record<string, unknown> = {
    domain,
    registrant: accountInfo.defaultRegistrant,
    admin: accountInfo.defaultAdmin,
    tech: accountInfo.defaultTech,
    billing: accountInfo.defaultBilling,
  };
  if (ns.length > 0) buyParams.ns = ns;

  const { success, code, msg } = await client.buyDomain(buyParams);
  if (success) {
    return { domain, available: true, action: "purchased", detail: "success", api_code: code ?? null, api_msg: msg };
  }
  return { domain, available: true, action: "purchase_failed", detail: `Code ${code}: ${msg}`, api_code: code ?? null, api_msg: msg };
}

async function runCheck(env: Env): Promise<DomainStatus[]> {
  if (!env.INWX_USERNAME || !env.INWX_PASSWORD) {
    throw new Error("INWX_USERNAME or INWX_PASSWORD is not configured");
  }
  const dryRun = isTrue(env.DRY_RUN);
  const delayMs = env.API_DELAY_MS ? Number(env.API_DELAY_MS) : 1000;
  const client = new InwxClient(env.INWX_API_URL || LIVE_API_URL);
  const statuses: DomainStatus[] = [];

  let loggedIn = false;
  try {
    await client.login(env.INWX_USERNAME, env.INWX_PASSWORD, env.INWX_SHARED_SECRET);
    loggedIn = true;

    const accountInfo = await client.getAccountInfo();
    const ns = [env.INWX_NS1, env.INWX_NS2].filter((v): v is string => Boolean(v));
    const domains = await loadDomains(env);

    for (let i = 0; i < domains.length; i++) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      const domain = domains[i];
      try {
        const status = await processDomain(client, domain, accountInfo, ns, dryRun);
        statuses.push(status);
        console.log(`[${i + 1}/${domains.length}] ${domain} -> ${status.action}`);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        statuses.push({ domain, available: null, action: "error", detail, api_code: null, api_msg: null });
        console.error(`[${i + 1}/${domains.length}] ${domain} -> error: ${detail}`);
      }
    }
  } finally {
    if (loggedIn) {
      await client.logout().catch(() => {});
    }
  }
  return statuses;
}

function summarize(record: RunRecord): string {
  if (record.error) return `INWX-Bot: Lauf fehlgeschlagen – ${record.error}`;
  const counts: Record<string, number> = {};
  for (const s of record.statuses) counts[s.action] = (counts[s.action] ?? 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${k}: ${v}`);
  const prefix = record.dryRun ? "INWX-Bot (Probelauf)" : "INWX-Bot";
  return `${prefix}: ${record.statuses.length} Domains geprüft – ${parts.join(", ") || "keine"}`;
}

async function notify(env: Env, record: RunRecord): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  // Only ping when something is worth knowing (available / bought / failed / errored).
  const noteworthy = Boolean(record.error) || record.statuses.some((s) => s.action !== "skipped");
  if (!noteworthy) return;

  const text = summarize(record);
  const interesting = record.statuses.filter((s) => s.action !== "skipped");
  try {
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` suits Slack, `content` suits Discord — sending both is harmless.
      body: JSON.stringify({ text, content: text, statuses: interesting }),
    });
  } catch {
    // Notifications are best-effort.
  }
}

async function runAndStore(env: Env): Promise<RunRecord> {
  const timestamp = new Date().toISOString();
  const dryRun = isTrue(env.DRY_RUN);
  let record: RunRecord;
  try {
    record = { timestamp, dryRun, statuses: await runCheck(env) };
  } catch (e) {
    record = { timestamp, dryRun, statuses: [], error: e instanceof Error ? e.message : String(e) };
  }
  await env.INWX_BOT.put(RESULTS_JSON_KEY, JSON.stringify(record, null, 2));
  await env.INWX_BOT.put(RESULTS_CSV_KEY, toCsv(record.statuses));
  await notify(env, record);
  return record;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
  });
}

function isAuthorized(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const [scheme, token] = (request.headers.get("authorization") ?? "").split(" ");
  return scheme === "Bearer" && token === env.ADMIN_TOKEN;
}

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Web dashboard (public shell; data calls below need the admin token).
  if (request.method === "GET" && (path === "/" || path === "/dashboard")) {
    const nonce = crypto.randomUUID().replace(/-/g, "");
    return new Response(dashboardPage(nonce), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          `default-src 'none'; base-uri 'none'; form-action 'self'; connect-src 'self'; ` +
          `img-src data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'`,
        "cache-control": "no-store",
      },
    });
  }

  // Public, low-detail status endpoint (no domain details leaked).
  if (request.method === "GET" && path === "/api/status") {
    const raw = await env.INWX_BOT.get(RESULTS_JSON_KEY);
    const last = raw ? (JSON.parse(raw) as RunRecord) : null;
    return json({
      ok: true,
      service: "inwx-bot worker",
      dryRun: isTrue(env.DRY_RUN),
      authConfigured: Boolean(env.ADMIN_TOKEN),
      lastRun: last?.timestamp ?? null,
      lastRunDomains: last?.statuses.length ?? 0,
      lastRunError: last?.error ?? null,
    });
  }

  // Everything below requires the admin bearer token.
  if (!isAuthorized(request, env)) return unauthorized();

  if (request.method === "GET" && path === "/api/results.csv") {
    const csv = (await env.INWX_BOT.get(RESULTS_CSV_KEY)) ?? "";
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8" } });
  }

  if (request.method === "GET" && path === "/api/results.json") {
    const raw = await env.INWX_BOT.get(RESULTS_JSON_KEY);
    return new Response(raw ?? "{}", { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (path === "/api/domains") {
    if (request.method === "GET") {
      return json({ domains: await loadDomains(env) });
    }
    if (request.method === "PUT" || request.method === "POST") {
      const domains = parseDomainList(await request.text());
      await env.INWX_BOT.put(DOMAINS_KEY, JSON.stringify(domains));
      return json({ ok: true, count: domains.length, domains });
    }
  }

  if (request.method === "POST" && path === "/api/run") {
    // `?async=true` returns immediately and runs in the background; otherwise
    // the run completes inline (suitable for small lists / manual triggers).
    if (url.searchParams.get("async") === "true") {
      ctx.waitUntil(runAndStore(env).then(() => undefined));
      return json({ ok: true, started: true }, 202);
    }
    const record = await runAndStore(env);
    return json({ ok: !record.error, ...record });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runAndStore(env).then(() => undefined));
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
