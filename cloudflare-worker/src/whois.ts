/**
 * WHOIS-style domain metadata via RDAP (the modern, JSON-over-HTTPS successor
 * to WHOIS). Works from a Worker with plain `fetch`.
 *
 * We query the rdap.org bootstrap which redirects to the authoritative RDAP
 * server for the domain's TLD. Note: some ccTLDs (notably .de / DENIC) do not
 * publish registration/expiry dates over RDAP — those fields stay null. For
 * domains in your own INWX account, `domain.info` is used instead (see index.ts).
 */

export interface WhoisInfo {
  domain: string;
  source: "inwx" | "rdap" | "none";
  available: boolean | null;
  status: string[];
  registered: string | null;
  expires: string | null;
  updated: string | null;
  registrar: string | null;
  error?: string;
}

interface RdapEvent {
  eventAction?: string;
  eventDate?: string;
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
}

interface RdapResponse {
  events?: RdapEvent[];
  status?: string[];
  entities?: RdapEntity[];
}

function baseInfo(domain: string): WhoisInfo {
  return {
    domain,
    source: "none",
    available: null,
    status: [],
    registered: null,
    expires: null,
    updated: null,
    registrar: null,
  };
}

function eventDate(events: RdapEvent[] | undefined, action: string): string | null {
  if (!events) return null;
  const found = events.find((ev) => (ev.eventAction ?? "").toLowerCase() === action);
  return found?.eventDate ?? null;
}

/** Extract a field (e.g. "fn") from a jCard / vcardArray structure. */
function vcardField(vcardArray: unknown, field: string): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const entries = vcardArray[1];
  if (!Array.isArray(entries)) return null;
  for (const item of entries) {
    if (Array.isArray(item) && item[0] === field && typeof item[3] === "string") {
      return item[3];
    }
  }
  return null;
}

function registrarName(entities: RdapEntity[] | undefined): string | null {
  if (!entities) return null;
  for (const entity of entities) {
    if ((entity.roles ?? []).includes("registrar")) {
      const name = vcardField(entity.vcardArray, "fn");
      if (name) return name;
    }
  }
  return null;
}

function parseRdap(domain: string, data: RdapResponse): WhoisInfo {
  return {
    domain,
    source: "rdap",
    available: false,
    status: Array.isArray(data.status) ? data.status : [],
    registered: eventDate(data.events, "registration"),
    expires: eventDate(data.events, "expiration"),
    updated: eventDate(data.events, "last changed"),
    registrar: registrarName(data.entities),
  };
}

export async function lookupRdap(domain: string): Promise<WhoisInfo> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: {
        accept: "application/rdap+json",
        // Some RDAP servers reject requests without a User-Agent (HTTP 403).
        "user-agent": "inwx-bot-worker (+https://github.com/koljasagorski/inwx_bot)",
      },
      redirect: "follow",
    });
    if (res.status === 404) {
      // RDAP "not found" generally means the domain is unregistered.
      return { ...baseInfo(domain), source: "rdap", available: true };
    }
    if (!res.ok) {
      return { ...baseInfo(domain), error: `RDAP HTTP ${res.status}` };
    }
    const data = (await res.json()) as RdapResponse;
    return parseRdap(domain, data);
  } catch (e) {
    return { ...baseInfo(domain), error: e instanceof Error ? e.message : String(e) };
  }
}
