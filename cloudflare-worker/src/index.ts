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
import { lookupRdap, type WhoisInfo } from "./whois";

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
  EXPIRY_ALERT_DAYS?: string;
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

interface WhoisRecord {
  timestamp: string;
  domains: WhoisInfo[];
}

interface RunSummary {
  timestamp: string;
  dryRun: boolean;
  total: number;
  counts: Record<string, number>;
  error?: string;
}

interface DomainChange {
  domain: string;
  from: Action | "new";
  to: Action;
}

interface DomainState {
  action?: Action;
  available?: boolean | null;
  /** Expiry the alert thresholds below refer to (reset when it changes). */
  expires?: string | null;
  /** Expiry-alert thresholds (in days) already sent for the current expiry. */
  notifiedExpiryDays?: number[];
}

type StateMap = Record<string, DomainState>;

type DomainMode = "watch" | "auto";

interface DomainConfig {
  domain: string;
  /** "auto": register when free (unless DRY_RUN); "watch": only report. */
  mode: DomainMode;
  /** Skip auto-purchase if the INWX price exceeds this (in account currency). */
  maxPrice?: number;
  tags?: string[];
  notes?: string;
}

const LIVE_API_URL = "https://api.domrobot.com/jsonrpc/";
const DOMAINS_KEY = "domains";
const RESULTS_JSON_KEY = "results:latest.json";
const RESULTS_CSV_KEY = "results:latest.csv";
const WHOIS_KEY = "whois:latest.json";
const HISTORY_KEY = "history:runs";
const STATE_KEY = "state:domains";
const META_KEY = "state:meta";
const LOCK_KEY = "lock:run";
const HISTORY_LIMIT = 50;
const DEFAULT_EXPIRY_ALERT_DAYS = [30, 14, 7, 1];

/** Actions that are worth a notification when a domain first reaches them. */
const INTERESTING_ACTIONS: Action[] = ["would_purchase", "purchased", "purchase_failed", "error"];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isTrue = (value: string | undefined) => (value ?? "").trim().toLowerCase() === "true";

/** Normalize one entry (plain string or object) into a DomainConfig. */
function normalizeConfig(input: unknown): DomainConfig | null {
  if (typeof input === "string") {
    const domain = input.trim();
    return domain ? { domain, mode: "auto" } : null;
  }
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const domain = String(obj.domain ?? "").trim();
    if (!domain) return null;
    const cfg: DomainConfig = { domain, mode: obj.mode === "watch" ? "watch" : "auto" };
    const maxPrice = Number(obj.maxPrice);
    if (obj.maxPrice !== undefined && obj.maxPrice !== null && obj.maxPrice !== "" && Number.isFinite(maxPrice)) {
      cfg.maxPrice = maxPrice;
    }
    if (Array.isArray(obj.tags)) {
      const tags = obj.tags.map((t) => String(t).trim()).filter(Boolean);
      if (tags.length > 0) cfg.tags = tags;
    }
    if (typeof obj.notes === "string" && obj.notes.trim()) cfg.notes = obj.notes.trim();
    return cfg;
  }
  return null;
}

/** Accepts a JSON array (of strings or objects) or newline-separated domains. */
function parseDomainConfigs(raw: string): DomainConfig[] {
  const trimmed = raw.trim();
  let entries: unknown[];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = trimmed.split(/\r?\n/);
    }
  } else {
    entries = trimmed.split(/\r?\n/);
  }
  return entries.map(normalizeConfig).filter((c): c is DomainConfig => c !== null);
}

async function loadDomainConfigs(env: Env): Promise<DomainConfig[]> {
  const raw = await env.INWX_BOT.get(DOMAINS_KEY);
  return raw ? parseDomainConfigs(raw) : [];
}

async function loadDomains(env: Env): Promise<string[]> {
  return (await loadDomainConfigs(env)).map((c) => c.domain);
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

function countsOf(statuses: DomainStatus[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const s of statuses) counts[s.action] = (counts[s.action] ?? 0) + 1;
  return counts;
}

async function readJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  const raw = await env.INWX_BOT.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const loadState = (env: Env) => readJson<StateMap>(env, STATE_KEY, {});
const saveState = (env: Env, state: StateMap) => env.INWX_BOT.put(STATE_KEY, JSON.stringify(state));

async function appendHistory(env: Env, summary: RunSummary): Promise<void> {
  const history = await readJson<RunSummary[]>(env, HISTORY_KEY, []);
  history.unshift(summary);
  await env.INWX_BOT.put(HISTORY_KEY, JSON.stringify(history.slice(0, HISTORY_LIMIT)));
}

// Best-effort mutual exclusion. KV is eventually consistent, so this only
// guards against the common case (an overlapping manual + scheduled run); it is
// not a hard lock.
async function acquireLock(env: Env, token: string, ttlSeconds = 600): Promise<boolean> {
  if (await env.INWX_BOT.get(LOCK_KEY)) return false;
  await env.INWX_BOT.put(LOCK_KEY, token, { expirationTtl: ttlSeconds });
  return true;
}

async function releaseLock(env: Env, token: string): Promise<void> {
  if ((await env.INWX_BOT.get(LOCK_KEY)) === token) await env.INWX_BOT.delete(LOCK_KEY);
}

async function withLock<T>(env: Env, fn: () => Promise<T>): Promise<{ skipped: true } | { skipped: false; result: T }> {
  const token = crypto.randomUUID();
  if (!(await acquireLock(env, token))) return { skipped: true };
  try {
    return { skipped: false, result: await fn() };
  } finally {
    await releaseLock(env, token);
  }
}

/** Domains whose action changed into an "interesting" state since last run. */
function detectRunChanges(prev: StateMap, statuses: DomainStatus[]): DomainChange[] {
  const changes: DomainChange[] = [];
  for (const s of statuses) {
    const before = prev[s.domain]?.action;
    if (s.action !== before && INTERESTING_ACTIONS.includes(s.action)) {
      changes.push({ domain: s.domain, from: before ?? "new", to: s.action });
    }
  }
  return changes;
}

function parseThresholds(raw: string | undefined): number[] {
  if (!raw) return DEFAULT_EXPIRY_ALERT_DAYS;
  const parsed = raw
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed.sort((a, b) => b - a) : DEFAULT_EXPIRY_ALERT_DAYS;
}

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86_400_000);
}

async function sendWebhook(env: Env, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;
  try {
    await fetch(env.NOTIFY_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` suits Slack, `content` suits Discord — sending both is harmless.
      body: JSON.stringify({ text, content: text, ...extra }),
    });
  } catch {
    // Notifications are best-effort.
  }
}

function buyParamsFor(domain: string, accountInfo: AccountInfo, ns: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {
    domain,
    registrant: accountInfo.defaultRegistrant,
    admin: accountInfo.defaultAdmin,
    tech: accountInfo.defaultTech,
    billing: accountInfo.defaultBilling,
  };
  if (ns.length > 0) params.ns = ns;
  return params;
}

async function processDomain(
  client: InwxClient,
  cfg: DomainConfig,
  accountInfo: AccountInfo,
  ns: string[],
  dryRun: boolean,
): Promise<DomainStatus> {
  const domain = cfg.domain;
  const { avail, price } = await client.checkDomain(domain);
  const priceNote = price !== null ? ` (Preis ${price})` : "";
  const notBought = (detail: string): DomainStatus => ({
    domain,
    available: true,
    action: "would_purchase",
    detail,
    api_code: null,
    api_msg: null,
  });

  if (!avail) {
    return { domain, available: false, action: "skipped", detail: "already registered", api_code: 1000, api_msg: "domain not available" };
  }
  // Available — decide whether to actually register it.
  if (cfg.mode === "watch") return notBought(`watch-only${priceNote}`);
  if (dryRun) return notBought(`dry run – not purchased${priceNote}`);
  if (cfg.maxPrice !== undefined) {
    if (price === null) return notBought(`price unknown – skipped (max ${cfg.maxPrice})`);
    if (price > cfg.maxPrice) return notBought(`over budget – ${price} > max ${cfg.maxPrice}`);
  }

  const { success, code, msg } = await client.buyDomain(buyParamsFor(domain, accountInfo, ns));
  if (success) {
    return { domain, available: true, action: "purchased", detail: `success${priceNote}`, api_code: code ?? null, api_msg: msg };
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
    const configs = await loadDomainConfigs(env);

    for (let i = 0; i < configs.length; i++) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      const cfg = configs[i];
      try {
        const status = await processDomain(client, cfg, accountInfo, ns, dryRun);
        statuses.push(status);
        console.log(`[${i + 1}/${configs.length}] ${cfg.domain} -> ${status.action}`);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        statuses.push({ domain: cfg.domain, available: null, action: "error", detail, api_code: null, api_msg: null });
        console.error(`[${i + 1}/${configs.length}] ${cfg.domain} -> error: ${detail}`);
      }
    }
  } finally {
    if (loggedIn) {
      await client.logout().catch(() => {});
    }
  }
  return statuses;
}

/**
 * Register a single domain on explicit user request (dashboard "Kaufen").
 * This is an explicit action and therefore ignores DRY_RUN and the per-domain
 * watch/auto mode — it always attempts the real purchase.
 */
async function buyDomainNow(
  env: Env,
  domain: string,
): Promise<{ ok: boolean; action: Action; detail: string; code?: number }> {
  if (!env.INWX_USERNAME || !env.INWX_PASSWORD) {
    return { ok: false, action: "error", detail: "INWX credentials not configured" };
  }
  const client = new InwxClient(env.INWX_API_URL || LIVE_API_URL);
  let loggedIn = false;
  try {
    await client.login(env.INWX_USERNAME, env.INWX_PASSWORD, env.INWX_SHARED_SECRET);
    loggedIn = true;
    const { avail } = await client.checkDomain(domain);
    if (!avail) return { ok: false, action: "skipped", detail: "not available" };
    const accountInfo = await client.getAccountInfo();
    const ns = [env.INWX_NS1, env.INWX_NS2].filter((v): v is string => Boolean(v));
    const { success, code, msg } = await client.buyDomain(buyParamsFor(domain, accountInfo, ns));
    return success
      ? { ok: true, action: "purchased", detail: "success", code }
      : { ok: false, action: "purchase_failed", detail: `Code ${code}: ${msg}`, code };
  } catch (e) {
    return { ok: false, action: "error", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (loggedIn) await client.logout().catch(() => {});
  }
}

const ACTION_LABELS_DE: Record<Action, string> = {
  skipped: "übersprungen",
  would_purchase: "verfügbar",
  purchased: "gekauft",
  purchase_failed: "Kauf fehlgeschlagen",
  error: "Fehler",
};

async function notifyRun(env: Env, record: RunRecord, changes: DomainChange[]): Promise<void> {
  if (!env.NOTIFY_WEBHOOK_URL) return;

  // De-duplicate fatal run errors so a persistent failure does not spam.
  if (record.error) {
    const meta = await readJson<{ lastNotifiedError?: string }>(env, META_KEY, {});
    if (meta.lastNotifiedError !== record.error) {
      await sendWebhook(env, `INWX-Bot: Lauf fehlgeschlagen – ${record.error}`);
      await env.INWX_BOT.put(META_KEY, JSON.stringify({ ...meta, lastNotifiedError: record.error }));
    }
    return;
  }
  // Clear a stored error once a run succeeds again.
  await env.INWX_BOT.put(META_KEY, JSON.stringify({}));

  // Only notify when a domain's status actually changed since the last run.
  if (changes.length === 0) return;
  const detail = changes.map((c) => `${c.domain}: ${ACTION_LABELS_DE[c.to]}`).join(", ");
  const prefix = record.dryRun ? "INWX-Bot (Probelauf)" : "INWX-Bot";
  await sendWebhook(env, `${prefix}: ${changes.length} Änderung(en) – ${detail}`, { changes });
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

  // Detect per-domain changes vs. the previous run, then persist the new state.
  const state = await loadState(env);
  const changes = detectRunChanges(state, record.statuses);
  for (const s of record.statuses) {
    state[s.domain] = { ...state[s.domain], action: s.action, available: s.available };
  }
  await saveState(env, state);

  await appendHistory(env, {
    timestamp,
    dryRun,
    total: record.statuses.length,
    counts: countsOf(record.statuses),
    error: record.error,
  });

  await notifyRun(env, record, changes);
  return record;
}

function inwxToWhois(domain: string, info: Record<string, unknown>): WhoisInfo {
  const status = info.status;
  const statusList = Array.isArray(status)
    ? status.map(String)
    : status
      ? [String(status)]
      : [];
  return {
    domain,
    source: "inwx",
    available: false,
    status: statusList,
    registered: (info.crDate as string) ?? null,
    expires: (info.exDate as string) ?? null,
    updated: (info.upDate as string) ?? null,
    registrar: "INWX",
  };
}

/** Prefer authoritative INWX data for owned domains; fall back to RDAP. */
async function enrichDomain(client: InwxClient | null, domain: string): Promise<WhoisInfo> {
  if (client) {
    try {
      const info = await client.getDomainInfo(domain);
      if (info) return inwxToWhois(domain, info);
    } catch {
      // not owned / API hiccup -> fall back to RDAP
    }
  }
  return lookupRdap(domain);
}

async function refreshWhois(env: Env): Promise<WhoisRecord> {
  const timestamp = new Date().toISOString();
  const delayMs = env.API_DELAY_MS ? Number(env.API_DELAY_MS) : 1000;
  const domains = await loadDomains(env);

  // Logging in is optional: without INWX credentials we still serve RDAP data.
  let client: InwxClient | null = null;
  let loggedIn = false;
  if (env.INWX_USERNAME && env.INWX_PASSWORD) {
    const c = new InwxClient(env.INWX_API_URL || LIVE_API_URL);
    try {
      await c.login(env.INWX_USERNAME, env.INWX_PASSWORD, env.INWX_SHARED_SECRET);
      client = c;
      loggedIn = true;
    } catch {
      client = null;
    }
  }

  const results: WhoisInfo[] = [];
  try {
    for (let i = 0; i < domains.length; i++) {
      if (i > 0 && delayMs > 0) await sleep(delayMs);
      try {
        results.push(await enrichDomain(client, domains[i]));
      } catch (e) {
        results.push({
          domain: domains[i],
          source: "none",
          available: null,
          status: [],
          registered: null,
          expires: null,
          updated: null,
          registrar: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } finally {
    if (loggedIn && client) await client.logout().catch(() => {});
  }

  const record: WhoisRecord = { timestamp, domains: results };
  await env.INWX_BOT.put(WHOIS_KEY, JSON.stringify(record, null, 2));
  await processExpiryAlerts(env, results);
  return record;
}

/** Notify once per crossed threshold as an owned/registered domain nears expiry. */
async function processExpiryAlerts(env: Env, results: WhoisInfo[]): Promise<void> {
  const thresholds = parseThresholds(env.EXPIRY_ALERT_DAYS);
  const state = await loadState(env);
  const alerts: string[] = [];

  for (const w of results) {
    const st: DomainState = state[w.domain] ?? {};
    // Reset the notified thresholds if the expiry date changed (e.g. renewed).
    if (st.expires !== (w.expires ?? null)) {
      st.expires = w.expires ?? null;
      st.notifiedExpiryDays = [];
    }
    const left = daysUntil(w.expires);
    if (left !== null && left >= 0) {
      const notified = st.notifiedExpiryDays ?? [];
      const crossed = thresholds.filter((t) => left <= t && !notified.includes(t));
      if (crossed.length > 0) {
        alerts.push(`${w.domain}: läuft in ${left} Tag(en) ab (${(w.expires ?? "").slice(0, 10)})`);
        st.notifiedExpiryDays = [...notified, ...crossed];
      }
    }
    state[w.domain] = st;
  }

  await saveState(env, state);
  if (alerts.length > 0) {
    await sendWebhook(env, `INWX-Bot: Ablauf-Warnung – ${alerts.join("; ")}`, { expiring: alerts });
  }
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
    const [raw, whoisRaw] = await Promise.all([
      env.INWX_BOT.get(RESULTS_JSON_KEY),
      env.INWX_BOT.get(WHOIS_KEY),
    ]);
    const last = raw ? (JSON.parse(raw) as RunRecord) : null;
    const whois = whoisRaw ? (JSON.parse(whoisRaw) as WhoisRecord) : null;
    return json({
      ok: true,
      service: "inwx-bot worker",
      dryRun: isTrue(env.DRY_RUN),
      authConfigured: Boolean(env.ADMIN_TOKEN),
      lastRun: last?.timestamp ?? null,
      lastRunDomains: last?.statuses.length ?? 0,
      lastRunError: last?.error ?? null,
      whoisLastRun: whois?.timestamp ?? null,
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
      return json({ domains: await loadDomainConfigs(env) });
    }
    if (request.method === "PUT" || request.method === "POST") {
      const domains = parseDomainConfigs(await request.text());
      await env.INWX_BOT.put(DOMAINS_KEY, JSON.stringify(domains));
      return json({ ok: true, count: domains.length, domains });
    }
  }

  if (request.method === "POST" && path === "/api/run") {
    // `?async=true` returns immediately and runs in the background; otherwise
    // the run completes inline (suitable for small lists / manual triggers).
    if (url.searchParams.get("async") === "true") {
      ctx.waitUntil(withLock(env, () => runAndStore(env)).then(() => undefined));
      return json({ ok: true, started: true }, 202);
    }
    const outcome = await withLock(env, () => runAndStore(env));
    if (outcome.skipped) return json({ ok: false, error: "a run is already in progress" }, 409);
    return json({ ok: !outcome.result.error, ...outcome.result });
  }

  if (request.method === "POST" && path === "/api/buy") {
    let body: { domain?: string } = {};
    try {
      body = (await request.json()) as { domain?: string };
    } catch {
      // ignore malformed body
    }
    const domain = (body.domain ?? "").trim();
    if (!domain) return json({ ok: false, error: "domain required" }, 400);
    const outcome = await withLock(env, () => buyDomainNow(env, domain));
    if (outcome.skipped) return json({ ok: false, error: "a run is already in progress" }, 409);
    return json({ domain, ...outcome.result });
  }

  if (request.method === "GET" && path === "/api/whois") {
    const raw = await env.INWX_BOT.get(WHOIS_KEY);
    return new Response(raw ?? "{}", { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  if (request.method === "POST" && path === "/api/whois/refresh") {
    if (url.searchParams.get("async") === "true") {
      ctx.waitUntil(withLock(env, () => refreshWhois(env)).then(() => undefined));
      return json({ ok: true, started: true }, 202);
    }
    const outcome = await withLock(env, () => refreshWhois(env));
    if (outcome.skipped) return json({ ok: false, error: "a refresh is already in progress" }, 409);
    return json({ ok: true, ...outcome.result });
  }

  if (request.method === "GET" && path === "/api/history") {
    const raw = await env.INWX_BOT.get(HISTORY_KEY);
    return new Response(raw ?? "[]", { headers: { "content-type": "application/json; charset=utf-8" } });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Run the availability check, then refresh WHOIS data (sequentially, so we
    // never hold two INWX sessions at once). A lock guards against overlap with
    // a manually triggered run.
    ctx.waitUntil(
      withLock(env, async () => {
        await runAndStore(env);
        await refreshWhois(env);
      }).then(() => undefined),
    );
  },
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleFetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
