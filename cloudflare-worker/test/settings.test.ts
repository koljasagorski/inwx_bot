import { describe, it, expect } from "vitest";
import { mergeSettings, expandCheckTargets, type Settings } from "../src/index";

const base: Settings = { dryRun: true, apiDelayMs: 1000, expiryAlertDays: [30, 14, 7, 1] };

describe("mergeSettings", () => {
  it("returns the base when there is no override", () => {
    expect(mergeSettings(base, {})).toEqual(base);
  });
  it("lets an override turn dry-run off", () => {
    expect(mergeSettings(base, { dryRun: false }).dryRun).toBe(false);
  });
  it("ignores an invalid (negative) delay", () => {
    expect(mergeSettings(base, { apiDelayMs: -5 }).apiDelayMs).toBe(1000);
  });
  it("accepts and sorts override thresholds", () => {
    expect(mergeSettings(base, { expiryAlertDays: [7, 60, 1] }).expiryAlertDays).toEqual([60, 7, 1]);
  });
});

describe("expandCheckTargets", () => {
  it("normalizes a single domain to lowercase", () => {
    expect(expandCheckTargets({ domain: "Example.DE" })).toEqual(["example.de"]);
  });
  it("expands a keyword across tlds, stripping junk and leading dots", () => {
    expect(expandCheckTargets({ keyword: "My Brand!", tlds: [".de", "com", " "] })).toEqual([
      "mybrand.de",
      "mybrand.com",
    ]);
  });
  it("returns nothing without enough input", () => {
    expect(expandCheckTargets({})).toEqual([]);
    expect(expandCheckTargets({ keyword: "x" })).toEqual([]);
  });
});
