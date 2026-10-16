import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({ logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) } }));
vi.mock("@/lib/probe-guard/allowlist-store", () => ({ getAllowlist: async () => [] }));
vi.mock("@/lib/probe-guard/abuse-store", () => ({
  getAbuseSettings: async () => ({ blocklists: { spamhaus: { enabled: false } } }),
  getDropRanges: async () => ({ ranges: [] }),
}));
vi.mock("@/lib/probe-guard/bans", () => ({
  neverBanContext: async () => ({ ownIps: ["198.51.100.7"], extraRanges: ["192.0.2.0/28"], allowlist: [] }),
}));

import { handleGuardRequest, type GuardDeps } from "@/lib/probe-guard/respond";
import { exemptCheck, isExempt, resetClientLists } from "@/lib/probe-guard/client-lists";
import { neverBanCheck } from "@/lib/probe-guard/ban-policy";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";
import { renderAppRobots } from "@/lib/probe-guard/robots";

const KEY = "k".repeat(64);

function harness(ip: string) {
  const recordHit = vi.fn(async () => 1);
  const ban = vi.fn(async () => ({ status: "refused" as const, reason: "test" }));
  const recordEvent = vi.fn(async () => {});
  const deps: GuardDeps = {
    hasKey: (v) => v === KEY,
    settings: async () => ({ ...DEFAULT_INSTANCE_PROBE_GUARD, threshold: 1 }),
    clientIp: async () => ip,
    recordHit,
    ban,
    recordEvent,
    markerFor: async () => ({ id: "c1", marker: "abcdefghjk23" }),
    activeMarkers: async () => [],
    markUsed: async () => {},
    appForHost: async () => null,
    robotsFor: renderAppRobots,
    // The wiring app/probe-guard/[kind]/route.ts uses.
    allowed: isExempt,
  };
  const request = new Request("http://console/probe-guard/probe", {
    headers: { "x-replaced-path": "/.env", host: "shop.example.com", "X-Vardo-Guard": KEY },
  });
  return { deps, request, recordHit, ban, recordEvent };
}

describe("addresses bans skip", () => {
  beforeEach(() => resetClientLists());

  it("records no hit, event or ban for a probe from the instance's own address", async () => {
    const { deps, request, recordHit, ban, recordEvent } = harness("198.51.100.7");
    const res = await handleGuardRequest("probe", request, deps);
    expect(res.status).toBe(404);
    expect(recordHit).not.toHaveBeenCalled();
    expect(recordEvent).not.toHaveBeenCalled();
    expect(ban).not.toHaveBeenCalled();
  });

  it("skips linked instances and private addresses too", async () => {
    for (const ip of ["192.0.2.5", "10.0.0.19"]) {
      const { deps, request, recordHit, ban } = harness(ip);
      await handleGuardRequest("probe", request, deps);
      expect(recordHit).not.toHaveBeenCalled();
      expect(ban).not.toHaveBeenCalled();
    }
  });

  it("still counts and bans a stranger", async () => {
    const { deps, request, recordHit, ban } = harness("203.0.113.50");
    await handleGuardRequest("probe", request, deps);
    expect(recordHit).toHaveBeenCalledOnce();
    expect(ban).toHaveBeenCalledOnce();
  });

  it("matches the filter the summaries use", async () => {
    const check = await exemptCheck();
    expect(check("198.51.100.7")).toBe(true);
    expect(check("::ffff:198.51.100.7")).toBe(true);
    expect(check("203.0.113.50")).toBe(false);
    expect(check("not an ip")).toBe(false);
  });
});

describe("neverBanCheck", () => {
  it("covers own addresses, extra ranges and the allowlist", () => {
    const check = neverBanCheck({ ownIps: ["198.51.100.7"], extraRanges: ["192.0.2.0/28"], allowlist: ["203.0.113.0/24"] });
    expect(check("198.51.100.7")).toBe(true);
    expect(check("192.0.2.9")).toBe(true);
    expect(check("203.0.113.9")).toBe(true);
    expect(check("198.51.100.8")).toBe(false);
  });
});
