import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeRedis } from "../../helpers/fake-redis";

vi.mock("@/lib/redis", async () => ({ redis: (await import("@/tests/unit/helpers/fake-redis")).createFakeRedis() }));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

import { redis } from "@/lib/redis";
import { BLOCKED_TTL_S, MAX_PENDING, blockedSummary, flushBlocks, recordBlock, setBanBlocksWriter, type BanBlocks } from "@/lib/probe-guard/blocked";
import { attributeBlock, rangeFinder } from "@/lib/probe-guard/block-source";
import { handleGuardRequest, type GuardDeps } from "@/lib/probe-guard/respond";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";
import { renderAppRobots } from "@/lib/probe-guard/robots";

const fake = redis as unknown as FakeRedis;
const KEY = "k".repeat(64);
const at = (iso: string) => new Date(iso).getTime();
let written: BanBlocks[] = [];

beforeEach(async () => {
  fake.ctl.down = false;
  fake.data.clear();
  written = [];
  setBanBlocksWriter(async (rows) => {
    written.push(...rows);
  });
  await flushBlocks();
});

const BANS = new Map([
  ["198.51.100.7", { id: "ban-abuse", blocklist: true, expiresAt: new Date("2099-01-01T00:00:00Z") }],
  ["198.51.100.8", { id: "ban-local", blocklist: false, expiresAt: new Date("2099-01-01T00:00:00Z") }],
]);
const RANGES = ["192.0.2.0/24", "2001:db8::/32"];

function deps(ip: string, over: Partial<GuardDeps> = {}): GuardDeps {
  const findRange = rangeFinder(RANGES);
  return {
    hasKey: (v) => v === KEY,
    settings: async () => DEFAULT_INSTANCE_PROBE_GUARD,
    clientIp: async () => ip,
    recordHit: async () => 1,
    ban: async () => ({ status: "refused", reason: "test" }),
    recordEvent: async () => {},
    markerFor: async () => ({ id: "c1", marker: "abcdefghjk23" }),
    activeMarkers: async () => [],
    markUsed: async () => {},
    appForHost: async () => null,
    robotsFor: renderAppRobots,
    allowed: async () => false,
    blockedRange: async (c) => findRange(c),
    banLookup: async () => (c) => BANS.get(c),
    recordBlock: (c, match) => recordBlock(c, match, at("2026-10-20T10:00:00Z")),
    ...over,
  };
}

function req(kind: string, path = "/", headers: Record<string, string> = {}) {
  return new Request(`http://console/probe-guard/${kind}`, {
    headers: { "X-Vardo-Guard": KEY, "x-replaced-path": path, ...headers },
  });
}

const today = async () => (await fake.hgetall("probe-guard:blocked:2026-10-20")) as Record<string, string>;

describe("blocked request counting", () => {
  it("counts an AbuseIPDB ban's request against AbuseIPDB and that ban", async () => {
    const res = await handleGuardRequest("banned", req("banned"), deps("198.51.100.7"));
    expect(res.status).toBe(403);
    await flushBlocks();
    expect(await today()).toEqual({ abuseipdb: "1" });
    expect(written).toEqual([{ id: "ban-abuse", count: 1, lastAt: new Date("2026-10-20T10:00:00Z") }]);
    expect(await fake.pfcount("probe-guard:blocked-ips:abuseipdb:2026-10-20")).toBe(1);
  });

  it("counts a local ban as local", async () => {
    await handleGuardRequest("banned", req("banned"), deps("198.51.100.8"));
    await handleGuardRequest("banned", req("banned"), deps("198.51.100.8"));
    await flushBlocks();
    expect(await today()).toEqual({ local: "2" });
    expect(written).toEqual([expect.objectContaining({ id: "ban-local", count: 2 })]);
  });

  it("counts a Spamhaus range on the banned router, by the peer Traefik saw", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9, 192.0.2.44" };
    await handleGuardRequest("banned", req("banned", "/", headers), deps("203.0.113.9"));
    await flushBlocks();
    expect(await today()).toEqual({ spamhaus: "1" });
    expect(await fake.pfcount("probe-guard:blocked-ranges:2026-10-20")).toBe(1);
    expect(written).toEqual([]);
  });

  it("counts a forwarded client in a Spamhaus range on the probe router", async () => {
    const res = await handleGuardRequest("probe", req("probe", "/.env"), deps("2001:db8:1::5"));
    expect(res.status).toBe(403);
    await flushBlocks();
    expect(await today()).toEqual({ spamhaus: "1" });
  });

  it("counts nothing for an allowlisted address", async () => {
    const d = deps("198.51.100.7", { allowed: async () => true });
    expect((await handleGuardRequest("banned", req("banned"), d)).status).toBe(403);
    await handleGuardRequest("probe", req("probe", "/.env"), deps("192.0.2.10", { allowed: async () => true }));
    await flushBlocks();
    expect(fake.data.size).toBe(0);
    expect(written).toEqual([]);
  });

  it("counts a block nothing explains as other", async () => {
    await handleGuardRequest("banned", req("banned"), deps("203.0.113.200"));
    await flushBlocks();
    expect(await today()).toEqual({ other: "1" });
  });

  it("rolls counts up by day: today, seven days and thirty", async () => {
    const m = { source: "abuseipdb" as const, banId: "b1" };
    recordBlock("198.51.100.1", m, at("2026-10-20T08:00:00Z"));
    recordBlock("198.51.100.1", m, at("2026-10-20T23:59:00Z"));
    recordBlock("198.51.100.2", m, at("2026-10-15T12:00:00Z"));
    recordBlock("198.51.100.3", m, at("2026-09-25T12:00:00Z"));
    recordBlock("198.51.100.4", m, at("2026-09-01T12:00:00Z"));
    await flushBlocks();
    expect(await fake.hgetall("probe-guard:blocked:2026-10-20")).toEqual({ abuseipdb: "2" });
    expect(await fake.pttl("probe-guard:blocked:2026-10-20")).toBeGreaterThan((BLOCKED_TTL_S - 5) * 1000);

    const summary = await blockedSummary(new Date("2026-10-20T12:00:00Z"));
    const abuse = summary.sources.find((s) => s.source === "abuseipdb")!;
    expect(abuse).toMatchObject({ today: 2, week: 3, month: 4, uniqueIps: 3 });
    expect(abuse.daily).toHaveLength(30);
    expect(abuse.daily.at(-1)).toBe(2);
    expect(summary.days.at(-1)).toBe("2026-10-20");
    expect(written).toEqual([{ id: "b1", count: 5, lastAt: new Date("2026-10-20T23:59:00Z") }]);
  });

  it("caps distinct addresses held between flushes but keeps counting", async () => {
    for (let i = 0; i < MAX_PENDING + 50; i++) recordBlock(`10.${i >> 16}.${(i >> 8) & 255}.${i & 255}`, { source: "spamhaus", range: "10.0.0.0/8" }, at("2026-10-20T10:00:00Z"));
    await flushBlocks();
    expect(await today()).toEqual({ spamhaus: String(MAX_PENDING + 50) });
    expect(await fake.pfcount("probe-guard:blocked-ips:spamhaus:2026-10-20")).toBeLessThanOrEqual(MAX_PENDING);
  });
});

describe("attribution", () => {
  it("prefers a ban over a range and a local ban over nothing", () => {
    const find = rangeFinder(RANGES);
    expect(attributeBlock(["192.0.2.5"], () => ({ id: "x", blocklist: false, expiresAt: new Date("2099-01-01T00:00:00Z") }), find)).toEqual({ source: "local", banId: "x" });
    expect(attributeBlock(["192.0.2.5"], () => undefined, find)).toEqual({ source: "spamhaus", range: "192.0.2.0/24" });
  });

  it("finds the most specific range, IPv4 and IPv6", () => {
    const find = rangeFinder(["203.0.113.0/24", "203.0.113.128/25", "2001:db8::/32"]);
    expect(find("203.0.113.200")).toBe("203.0.113.128/25");
    expect(find("203.0.113.5")).toBe("203.0.113.0/24");
    expect(find("2001:db8:ffff::1")).toBe("2001:db8::/32");
    expect(find("2001:db9::1")).toBeNull();
    expect(find("not-an-ip")).toBeNull();
  });
});
