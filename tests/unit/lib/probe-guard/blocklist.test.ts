import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

import { banRenderOrder, rangeNeverBanReason, rangesOverlap } from "@/lib/probe-guard/ban-policy";
import { PERMANENT_UNTIL } from "@/lib/probe-guard/permanent";
import { BLACKLIST_LIMIT, createAbuseIpdbBlocklist, parseBlacklist } from "@/lib/probe-guard/blocklist/abuseipdb";
import { DROP_FEEDS, createSpamhausDrop, parseDropFeed } from "@/lib/probe-guard/blocklist/spamhaus";
import { REFRESH_MS, blockableRanges, isDue, runBlocklistPass, type ImportDeps } from "@/lib/probe-guard/blocklist/import";
import { DEFAULT_ABUSE_SETTINGS, EMPTY_ABUSE_STATUS, type AbuseSettings, type AbuseStatus } from "@/lib/probe-guard/abuse-settings";
import { MAX_RENDERED_RANGES, banClause, isValidGuardFile, renderGuardFile } from "@/lib/probe-guard/traefik-file";
import type { BlocklistProvider } from "@/lib/probe-guard/blocklist/types";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-03-01T12:00:00Z");

describe("parsing", () => {
  it("reads DROP's JSON lines and skips the metadata line", () => {
    const text = [
      '{"cidr":"198.51.100.0/24","sblid":"SBL000001","rir":"arin"}',
      '{"cidr":"2001:db8:4000::/34","sblid":"SBL000002","rir":"ripencc"}',
      '{"cidr":"not-a-range","sblid":"SBL000003"}',
      "garbage",
      '{"type":"metadata","timestamp":1772366400,"size":123,"records":2}',
    ].join("\n");
    expect(parseDropFeed(text).map((e) => e.value)).toEqual(["198.51.100.0/24", "2001:db8:4000::/34"]);
  });

  it("keeps blacklist entries at or above the threshold", () => {
    const body = { data: [
      { ipAddress: "203.0.113.1", abuseConfidenceScore: 100 },
      { ipAddress: "203.0.113.2", abuseConfidenceScore: 80 },
      { ipAddress: "nope", abuseConfidenceScore: 100 },
    ] };
    expect(parseBlacklist(body, 90)).toEqual([{ value: "203.0.113.1", score: 100 }]);
    expect(() => parseBlacklist({}, 90)).toThrow();
  });

  it("asks AbuseIPDB for 10,000 entries at the threshold", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await createAbuseIpdbBlocklist(fetchMock as unknown as typeof fetch).fetch({ apiKey: "k", minConfidence: 90 });
    const url = new URL((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname).toBe("/api/v2/blacklist");
    expect(url.searchParams.get("limit")).toBe(String(BLACKLIST_LIMIT));
    expect(url.searchParams.get("confidenceMinimum")).toBe("90");
  });

  it("fetches both DROP feeds", async () => {
    const fetchMock = vi.fn(async () => new Response('{"cidr":"198.51.100.0/24"}\n', { status: 200 }));
    const entries = await createSpamhausDrop(fetchMock as unknown as typeof fetch).fetch({ apiKey: null, minConfidence: 0 });
    expect(fetchMock.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(DROP_FEEDS);
    expect(entries).toHaveLength(2);
  });
});

describe("never-ban overlap", () => {
  it("detects nesting either way", () => {
    expect(rangesOverlap("198.51.100.0/24", "198.51.100.7")).toBe(true);
    expect(rangesOverlap("198.51.100.128/25", "198.51.100.0/24")).toBe(true);
    expect(rangesOverlap("198.51.100.0/24", "198.51.101.0/24")).toBe(false);
    expect(rangesOverlap("198.51.100.0/24", "2001:db8::/32")).toBe(false);
  });

  it("skips ranges touching private, Cloudflare, own, linked or allowlisted addresses", () => {
    const ctx = { ownIps: ["203.0.113.5"], extraRanges: ["198.51.100.9"], allowlist: ["192.0.2.0/25"] };
    expect(rangeNeverBanReason("10.1.0.0/16", ctx)).not.toBeNull();
    expect(rangeNeverBanReason("104.16.0.0/16", ctx)).not.toBeNull();
    expect(rangeNeverBanReason("203.0.113.0/24", ctx)).not.toBeNull();
    expect(rangeNeverBanReason("198.51.100.0/24", ctx)).not.toBeNull();
    expect(rangeNeverBanReason("192.0.2.0/24", ctx)).not.toBeNull();
    expect(blockableRanges(["192.0.2.0/24", "198.18.0.0/24", "198.19.0.0/16", "198.18.0.0/24"], ctx)).toEqual(["198.19.0.0/16", "198.18.0.0/24"]);
  });
});

function provider(over: Partial<BlocklistProvider> & Pick<BlocklistProvider, "id" | "kind">): BlocklistProvider {
  return { label: over.id, needsKey: false, minIntervalMs: HOUR, fetch: async () => [], ...over };
}

function harness(settings: AbuseSettings, status: AbuseStatus = EMPTY_ABUSE_STATUS, providers?: BlocklistProvider[]) {
  const calls: string[] = [];
  let current = status;
  const deps: ImportDeps = {
    providers: providers ?? [
      provider({ id: "abuseipdb", kind: "addresses", needsKey: true, fetch: async () => [{ value: "203.0.113.20", score: 100 }] }),
      provider({ id: "spamhaus", kind: "ranges", fetch: async () => [{ value: "198.18.0.0/15" }, { value: "10.0.0.0/8" }] }),
    ],
    settings: async () => settings,
    apiKey: async () => "key",
    status: async () => current,
    setSource: async (id, s) => {
      current = { ...current, blocklists: { ...current.blocklists, [id]: s } };
    },
    neverBanContext: async () => ({}),
    applyAddresses: async (entries) => {
      calls.push(`apply:${entries.map((e) => e.ip).join(",")}`);
      return entries.length;
    },
    clearAddresses: async () => {
      calls.push("clear");
      return 1;
    },
    setRanges: async (ranges) => void calls.push(`ranges:${ranges.join(",")}`),
    now: () => T0,
  };
  return { deps, calls, status: () => current };
}

const on: AbuseSettings = {
  ...DEFAULT_ABUSE_SETTINGS,
  blocklists: { abuseipdb: { enabled: true, minConfidence: 90 }, spamhaus: { enabled: true } },
};

describe("blocklist import", () => {
  it("fetches nothing while both toggles are off, the default", async () => {
    const h = harness(DEFAULT_ABUSE_SETTINGS);
    expect(await runBlocklistPass(h.deps)).toEqual({});
    expect(h.calls).toEqual([]);
  });

  it("applies addresses as bans and never-ban-free ranges", async () => {
    const h = harness(on);
    expect(await runBlocklistPass(h.deps)).toEqual({ abuseipdb: "fetched", spamhaus: "fetched" });
    expect(h.calls).toEqual(["apply:203.0.113.20", "ranges:198.18.0.0/15"]);
    expect(h.status().blocklists.spamhaus).toMatchObject({ count: 1, error: null });
    expect(h.status().blocklists.abuseipdb).toMatchObject({ count: 1, fetchedWith: "confidence:90" });
  });

  it("refreshes daily, never more than hourly, and on a threshold change", () => {
    const p = provider({ id: "abuseipdb", kind: "addresses" });
    const fetchedAt = new Date(T0).toISOString();
    const status = { count: 1, fetchedAt, attemptedAt: fetchedAt, error: null, fetchedWith: "confidence:90" };
    expect(isDue(p, status, "confidence:90", T0 + HOUR)).toBe(false);
    expect(isDue(p, status, "confidence:90", T0 + REFRESH_MS)).toBe(true);
    expect(isDue(p, status, "confidence:95", T0 + HOUR)).toBe(true);
    expect(isDue(p, status, "confidence:95", T0 + 60_000)).toBe(false);
  });

  it("records a failed fetch and keeps the last good count", async () => {
    const failing = [provider({ id: "spamhaus", kind: "ranges", fetch: async () => { throw new Error("Spamhaus answered 503"); } })];
    const prior: AbuseStatus = { ...EMPTY_ABUSE_STATUS, blocklists: { ...EMPTY_ABUSE_STATUS.blocklists, spamhaus: { count: 4, fetchedAt: new Date(T0 - 2 * REFRESH_MS).toISOString(), attemptedAt: null, error: null, fetchedWith: "drop" } } };
    const h = harness(on, prior, failing);
    expect(await runBlocklistPass(h.deps)).toEqual({ spamhaus: "failed" });
    expect(h.status().blocklists.spamhaus).toMatchObject({ count: 4, error: "Spamhaus answered 503" });
  });

  it("clears a source once it's turned off", async () => {
    const prior: AbuseStatus = {
      ...EMPTY_ABUSE_STATUS,
      blocklists: {
        abuseipdb: { count: 3, fetchedAt: new Date(T0).toISOString(), attemptedAt: null, error: null, fetchedWith: "confidence:90" },
        spamhaus: { count: 2, fetchedAt: new Date(T0).toISOString(), attemptedAt: null, error: null, fetchedWith: "drop" },
      },
    };
    const h = harness(DEFAULT_ABUSE_SETTINGS, prior);
    expect(await runBlocklistPass(h.deps)).toEqual({ abuseipdb: "cleared", spamhaus: "cleared" });
    expect(h.calls).toEqual(["clear", "ranges:"]);
    expect(h.status().blocklists.abuseipdb.count).toBe(0);
  });
});

describe("render priority", () => {
  const at = (h: number) => new Date(T0 - h * HOUR);
  const until = new Date(T0 + 24 * HOUR);

  it("puts permanent bans first, then local bans, then blocklist bans by confidence", () => {
    const rows = [
      { ip: "203.0.113.30", reason: "blocklist", hits: 95, createdAt: at(0), expiresAt: until },
      { ip: "203.0.113.31", reason: "blocklist", hits: 100, createdAt: at(0), expiresAt: until },
      { ip: "203.0.113.1", reason: "threshold", hits: 5, createdAt: at(2), expiresAt: until },
      { ip: "203.0.113.2", reason: "trap", hits: 1, createdAt: at(1), expiresAt: until },
      { ip: "203.0.113.9", reason: "threshold", hits: 5, createdAt: at(400), expiresAt: PERMANENT_UNTIL },
    ];
    expect(banRenderOrder(rows, 10)).toEqual(["203.0.113.9", "203.0.113.2", "203.0.113.1", "203.0.113.31", "203.0.113.30"]);
  });

  it("caps blocklist bans separately and never crowds out local ones", () => {
    const blocklist = Array.from({ length: 20 }, (_, i) => ({ ip: `198.51.100.${i}`, reason: "blocklist", hits: 100, createdAt: at(0), expiresAt: until }));
    const local = Array.from({ length: 4 }, (_, i) => ({ ip: `203.0.113.${i}`, reason: "threshold", hits: 5, createdAt: at(i), expiresAt: until }));
    const order = banRenderOrder([...blocklist, ...local], 10, 3);
    expect(order.slice(0, 4)).toEqual(["203.0.113.0", "203.0.113.1", "203.0.113.2", "203.0.113.3"]);
    expect(order).toHaveLength(7);
    expect(banRenderOrder([...blocklist, ...local], 5, 3).slice(0, 4)).toEqual(local.map((l) => l.ip));
  });

  it("renders ranges as ClientIP matchers, capped", () => {
    expect(banClause([], ["198.18.0.0/15"])).toBe("(ClientIP(`198.18.0.0/15`))");
    const many = Array.from({ length: MAX_RENDERED_RANGES + 5 }, (_, i) => `100.${Math.floor(i / 256)}.${i % 256}.0/24`);
    expect(banClause([], many)!.match(/ClientIP/g)).toHaveLength(MAX_RENDERED_RANGES);
    const file = renderGuardFile({
      key: "a".repeat(64),
      apps: [{ id: "app1", hosts: ["shop.example.com"], exceptions: [], wordpress: false, robotsTxt: false }],
      bannedIps: ["203.0.113.1"],
      bannedRanges: ["198.18.0.0/15", "2001:db8:4000::/34"],
      trapPaths: [],
      markers: [],
    });
    expect(file).toContain("ClientIP(`2001:db8:4000::/34`)");
    expect(isValidGuardFile(file)).toBe(true);
  });
});
