import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRdap, lookupRdap } from "../src/whois";

describe("parseRdap", () => {
  it("extracts events, status and registrar", () => {
    const out = parseRdap("example.com", {
      status: ["client transfer prohibited"],
      events: [
        { eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
        { eventAction: "expiration", eventDate: "2026-08-13T04:00:00Z" },
        { eventAction: "last changed", eventDate: "2026-01-16T18:26:50Z" },
      ],
      entities: [
        {
          roles: ["registrar"],
          vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar"]]],
        },
      ],
    });
    expect(out).toMatchObject({
      domain: "example.com",
      source: "rdap",
      available: false,
      registered: "1995-08-14T04:00:00Z",
      expires: "2026-08-13T04:00:00Z",
      updated: "2026-01-16T18:26:50Z",
      registrar: "Example Registrar",
      status: ["client transfer prohibited"],
    });
  });
});

describe("lookupRdap", () => {
  afterEach(() => vi.restoreAllMocks());

  it("treats HTTP 404 as available", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    const out = await lookupRdap("free-xyz-9182736455.com");
    expect(out.available).toBe(true);
    expect(out.source).toBe("rdap");
  });

  it("reports other HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const out = await lookupRdap("x.com");
    expect(out.error).toContain("403");
  });
});
