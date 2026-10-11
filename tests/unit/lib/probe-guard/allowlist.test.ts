import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

import YAML from "yaml";
import {
  MAX_ALLOW_ENTRIES,
  allowEntryInputSchema,
  allowValueProblem,
  bansCovered,
  normalizeAllowlist,
} from "@/lib/probe-guard/allowlist";
import { neverBanReason } from "@/lib/probe-guard/ban-policy";
import { addressPattern, isValidGuardFile, renderGuardFile, skipClause, type GuardState } from "@/lib/probe-guard/traefik-file";
import { handleGuardRequest, type GuardDeps } from "@/lib/probe-guard/respond";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";
import { renderAppRobots } from "@/lib/probe-guard/robots";
import { drainReports } from "@/lib/probe-guard/reporting/drain";
import { KeyedCooldown } from "@/lib/net/cooldown";
import { DEFAULT_ABUSE_SETTINGS } from "@/lib/probe-guard/abuse-settings";
import type { BanRequest } from "@/lib/probe-guard/bans";

describe("allowlist validation", () => {
  it("accepts addresses and ranges", () => {
    for (const v of ["203.0.113.7", "198.51.100.0/24", "203.0.0.0/8", "2001:db8::1", "2001:db8::/32", "2001::/16"]) {
      expect(allowValueProblem(v)).toBeNull();
    }
  });

  it("rejects malformed values", () => {
    for (const v of ["", "example.com", "203.0.113.300", "203.0.113.0/33", "2001:db8::/129", "1.2.3.4/24/1", "203.0.113.0/x"]) {
      expect(allowValueProblem(v)).not.toBeNull();
    }
  });

  it("rejects ranges that are too broad", () => {
    expect(allowValueProblem("0.0.0.0/0")).toMatch(/every address/);
    expect(allowValueProblem("::/0")).toMatch(/every address/);
    expect(allowValueProblem("203.0.0.0/7")).toMatch(/broader than \/8/);
    expect(allowValueProblem("2001::/15")).toMatch(/broader than \/16/);
  });

  it("normalizes on input", () => {
    expect(allowEntryInputSchema.parse({ value: " 203.0.113.7/32 " })).toEqual({ value: "203.0.113.7", note: "", skipGuard: false });
    expect(allowEntryInputSchema.parse({ value: "2001:DB8::/32", note: "Scanner" }).value).toBe("2001:db8::/32");
    expect(allowEntryInputSchema.safeParse({ value: "0.0.0.0/0" }).success).toBe(false);
  });

  it("defaults the guard skip to off", () => {
    expect(allowEntryInputSchema.parse({ value: "203.0.113.7" }).skipGuard).toBe(false);
  });

  it("reads stored lists defensively and caps them", () => {
    const entry = (i: number) => ({ id: `e${i}`, value: `203.0.113.${i % 250}`, note: "", skipGuard: false, addedBy: null, addedAt: "2026-01-01T00:00:00.000Z" });
    expect(normalizeAllowlist({ entries: [entry(1), { id: "bad", value: "0.0.0.0/0" }, "junk"] })).toHaveLength(1);
    expect(normalizeAllowlist({ entries: Array.from({ length: 300 }, (_, i) => entry(i)) })).toHaveLength(MAX_ALLOW_ENTRIES);
    expect(normalizeAllowlist(null)).toEqual([]);
  });
});

describe("allowlisted addresses", () => {
  it("are never banned", () => {
    expect(neverBanReason("203.0.113.7", { allowlist: ["203.0.113.7"] })).toBe("on the allowlist");
    expect(neverBanReason("198.51.100.44", { allowlist: ["198.51.100.0/24"] })).toBe("on the allowlist");
    expect(neverBanReason("198.51.101.1", { allowlist: ["198.51.100.0/24"] })).toBeNull();
  });

  it("cover the bans adding them lifts", () => {
    const bans = [{ id: "a", ip: "198.51.100.4" }, { id: "b", ip: "198.51.100.200" }, { id: "c", ip: "203.0.113.1" }];
    expect(bansCovered(bans, "198.51.100.0/24").map((b) => b.id)).toEqual(["a", "b"]);
    expect(bansCovered(bans, "203.0.113.1").map((b) => b.id)).toEqual(["c"]);
  });

  it("are skipped by the reporter", async () => {
    let queued = true;
    const sent: string[] = [];
    const result = await drainReports({
      store: {
        enqueue: async () => true,
        due: async () => (queued ? ["203.0.113.7"] : []),
        remove: async () => {
          const was = queued;
          queued = false;
          return was;
        },
        requeue: async () => {},
        dropBefore: async () => {},
        recentlyReported: async () => false,
        markReported: async () => {},
        reserveDaily: async () => true,
        releaseDaily: async () => {},
        dailyCount: async () => 0,
      },
      cooldown: new KeyedCooldown({ baseMs: 1000, maxMs: 1000 }),
      reporter: { id: "abuseipdb", label: "AbuseIPDB", report: async (r) => void sent.push(r.ip), testKey: async () => ({ ok: true }) },
      settings: async () => ({ ...DEFAULT_ABUSE_SETTINGS, reporting: { enabled: true, dailyCap: 500 } }),
      apiKey: async () => "key",
      neverBanContext: async () => ({ allowlist: ["203.0.113.0/24"] }),
      draft: async (ip) => ({ report: { ip, categories: ["web-attack"], comment: "x" }, appId: null }),
      recordReported: async () => {},
      setStatus: async () => {},
    });
    expect(result.skipped).toBe(1);
    expect(sent).toEqual([]);
  });

  it("answer probes but never count toward a ban", async () => {
    const bans: BanRequest[] = [];
    const recorded: string[] = [];
    const hits = vi.fn(async () => 99);
    const deps: GuardDeps = {
      hasKey: (v) => v === "k".repeat(64),
      settings: async () => DEFAULT_INSTANCE_PROBE_GUARD,
      clientIp: async () => "203.0.113.7",
      recordHit: hits,
      ban: async (r) => {
        bans.push(r);
        return { status: "refused", reason: "test" };
      },
      recordEvent: async (e) => void recorded.push(e.kind),
      markerFor: async () => ({ id: "c", marker: "abcdefghjk23" }),
      activeMarkers: async () => [],
      markUsed: async () => {},
      appForHost: async () => null,
      robotsFor: renderAppRobots,
      allowed: async () => true,
    };
    for (const [kind, path] of [["probe", "/.env"], ["trap", "/admin-backup/x"], ["canary", "/"]] as const) {
      const res = await handleGuardRequest(kind, new Request(`http://console/probe-guard/${kind}`, { headers: { "X-Vardo-Guard": "k".repeat(64), "x-replaced-path": path } }), deps);
      expect([403, 404]).toContain(res.status);
    }
    expect(hits).not.toHaveBeenCalled();
    expect(bans).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe("skip-guard rendering", () => {
  const KEY = "a".repeat(64);
  const state = (over: Partial<GuardState> = {}): GuardState => ({
    key: KEY,
    apps: [{ id: "app1", hosts: ["shop.example.com"], exceptions: [], wordpress: false, robotsTxt: false }],
    bannedIps: ["198.51.100.66"],
    trapPaths: ["/admin-backup/"],
    markers: ["abcdefghjk23"],
    ...over,
  });
  type Routers = Record<string, { rule: string }>;
  const routers = (s: GuardState) => (YAML.parse(renderGuardFile(s)) as { http: { routers: Routers } }).http.routers;

  it("adds nothing without skip entries", () => {
    expect(routers(state())["vardo-guard-app1-probe-web"].rule).not.toContain("!(");
  });

  it("excludes skip entries from the probe, trap and canary routers only", () => {
    const s = state({ skipClients: ["203.0.113.7", "198.51.100.0/24"], forwardingPeers: ["173.245.48.0/20", "10.0.0.0/8"] });
    const r = routers(s);
    for (const name of ["vardo-guard-app1-probe-web", "vardo-guard-app1-trap-websecure", "vardo-guard-canary-web"]) {
      expect(r[name].rule).toContain("&& !(ClientIP(`203.0.113.7`) || ClientIP(`198.51.100.0/24`)");
    }
    expect(r["vardo-guard-banned-web"].rule).not.toContain("!(");
    expect(isValidGuardFile(renderGuardFile(s))).toBe(true);
  });

  it("trusts only the last X-Forwarded-For hop and Cf-Connecting-Ip from a forwarding peer", () => {
    const clause = skipClause(["203.0.113.7"], ["173.245.48.0/20"])!;
    expect(clause).toContain("HeaderRegexp(`X-Forwarded-For`, `(?i)(?:^|[\\s,])(?:203\\.0\\.113\\.7)\\s*$`)");
    expect(clause).toContain("((ClientIP(`173.245.48.0/20`)) && HeaderRegexp(`Cf-Connecting-Ip`");
    const xff = new RegExp(clause.match(/X-Forwarded-For`, `\(\?i\)(.*?)`\)/)![1], "i");
    expect(xff.test("198.51.100.1, 203.0.113.7")).toBe(true);
    expect(xff.test("203.0.113.7, 198.51.100.1")).toBe(false);
  });

  it("writes CIDRs as header patterns", () => {
    const re = (entry: string) => new RegExp(`^(?:${addressPattern(entry)})$`, "i");
    expect(re("198.51.100.0/24").test("198.51.100.250")).toBe(true);
    expect(re("198.51.100.0/24").test("198.51.101.1")).toBe(false);
    expect(re("203.0.113.64/26").test("203.0.113.127")).toBe(true);
    expect(re("203.0.113.64/26").test("203.0.113.128")).toBe(false);
    expect(re("203.0.113.64/26").test("203.0.113.63")).toBe(false);
    expect(re("2001:db8::/32").test("2001:db8:1::5")).toBe(true);
    expect(re("2001:db8::/32").test("2001:db80::5")).toBe(false);
    expect(addressPattern("2001:db8::/33")).toBeNull();
  });
});
