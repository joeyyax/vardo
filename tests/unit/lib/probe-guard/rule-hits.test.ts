import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeRedis } from "../../helpers/fake-redis";

vi.mock("@/lib/redis", async () => ({ redis: (await import("@/tests/unit/helpers/fake-redis")).createFakeRedis() }));
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

import { redis } from "@/lib/redis";
import { DAY_TTL_S, HOUR_TTL_S, RULE_SINCE_KEY, recordHit, ruleHits } from "@/lib/probe-guard/hits";
import { handleGuardRequest, type GuardDeps } from "@/lib/probe-guard/respond";
import { approximateNote, fallbackUntil, ruleHitRows } from "@/lib/probe-guard/history-view";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";
import { renderAppRobots } from "@/lib/probe-guard/robots";

const fake = redis as unknown as FakeRedis;
const WINDOW = 600_000;
const at = (iso: string) => new Date(iso).getTime();

beforeEach(() => {
  fake.ctl.down = false;
  fake.data.clear();
});

describe("rule hit counters", () => {
  it("count per rule, instance-wide and per app, per day and per hour", async () => {
    const now = at("2026-10-20T10:30:00Z");
    await recordHit("203.0.113.1", "app1", WINDOW, "dotenv", now);
    await recordHit("203.0.113.2", "app1", WINDOW, "dotenv", now);
    await recordHit("203.0.113.3", "app2", WINDOW, "git", now);

    expect(await fake.hgetall("probe-guard:rule-hits:_all:2026-10-20")).toEqual({ dotenv: "2", git: "1" });
    expect(await fake.hgetall("probe-guard:rule-hits:app1:2026-10-20")).toEqual({ dotenv: "2" });
    expect(await fake.hgetall("probe-guard:rule-hits-hour:_all:2026-10-20T10")).toEqual({ dotenv: "2", git: "1" });
    expect(await fake.hgetall("probe-guard:rule-hits-hour:app2:2026-10-20T10")).toEqual({ git: "1" });
  });

  it("count only instance-wide when no app is named", async () => {
    await recordHit("203.0.113.1", null, WINDOW, "dotenv", at("2026-10-20T10:30:00Z"));
    expect(await fake.hgetall("probe-guard:rule-hits:_all:2026-10-20")).toEqual({ dotenv: "1" });
    expect(fake.data.size).toBe(6);
  });

  it("expire daily counters after 92 days and hourly ones after 50 hours", async () => {
    expect(DAY_TTL_S).toBe(92 * 86_400);
    expect(HOUR_TTL_S).toBe(50 * 3_600);
    await recordHit("203.0.113.1", "app1", WINDOW, "dotenv", at("2026-10-20T10:30:00Z"));
    expect(await fake.pttl("probe-guard:rule-hits:app1:2026-10-20")).toBeGreaterThan((DAY_TTL_S - 5) * 1000);
    expect(await fake.pttl("probe-guard:rule-hits-hour:app1:2026-10-20T10")).toBeGreaterThan((HOUR_TTL_S - 5) * 1000);
  });

  it("keep the window count and the first counting time", async () => {
    expect(await recordHit("203.0.113.1", null, WINDOW, "dotenv", at("2026-10-20T10:30:00Z"))).toBe(1);
    expect(await recordHit("203.0.113.1", null, WINDOW, "git", at("2026-10-20T10:31:00Z"))).toBe(2);
    expect(await fake.get(RULE_SINCE_KEY)).toBe(String(at("2026-10-20T10:30:00Z")));
  });

  it("sum across an hour boundary", async () => {
    await recordHit("203.0.113.1", "app1", WINDOW, "dotenv", at("2026-10-20T09:59:00Z"));
    await recordHit("203.0.113.1", "app1", WINDOW, "dotenv", at("2026-10-20T10:01:00Z"));
    await recordHit("203.0.113.1", "app1", WINDOW, "git", at("2026-10-20T10:02:00Z"));
    const now = new Date("2026-10-20T10:30:00Z");
    expect((await ruleHits("app1", "hour", 2, now)).counts).toEqual({ dotenv: 2, git: 1 });
    expect((await ruleHits("app1", "hour", 1, now)).counts).toEqual({ dotenv: 1, git: 1 });
  });

  it("sum across a day boundary", async () => {
    await recordHit("203.0.113.1", null, WINDOW, "dotenv", at("2026-10-19T23:59:00Z"));
    await recordHit("203.0.113.1", null, WINDOW, "dotenv", at("2026-10-20T00:01:00Z"));
    await recordHit("203.0.113.1", null, WINDOW, "ssh", at("2026-10-17T12:00:00Z"));
    const now = new Date("2026-10-20T08:00:00Z");
    const two = await ruleHits(null, "day", 2, now);
    expect(two.counts).toEqual({ dotenv: 2 });
    expect(two.since).toEqual(new Date("2026-10-19T23:59:00Z"));
    expect((await ruleHits(null, "day", 4, now)).counts).toEqual({ dotenv: 2, ssh: 1 });
  });

  it("report no counting start before the first hit", async () => {
    expect(await ruleHits(null, "day", 7, new Date("2026-10-20T08:00:00Z"))).toEqual({ counts: {}, since: null });
  });

  it("reject when Redis is down so the caller can fall back", async () => {
    fake.ctl.down = true;
    await expect(ruleHits(null, "day", 7)).rejects.toThrow();
  });
});

describe("falling back to events", () => {
  const since = new Date("2026-10-13T12:00:00Z");
  const now = new Date("2026-10-20T12:00:00Z");

  it("uses events only before counting began", () => {
    expect(fallbackUntil(since, new Date("2026-10-15T00:00:00Z"), now)).toEqual(new Date("2026-10-15T00:00:00Z"));
  });

  it("uses no events when counting covers the range", () => {
    expect(fallbackUntil(since, new Date("2026-10-01T00:00:00Z"), now)).toBeNull();
  });

  it("uses events for the whole range when nothing is counted yet", () => {
    expect(fallbackUntil(since, null, now)).toEqual(now);
  });

  it("marks approximate only when events supplied hits", () => {
    const until = new Date("2026-10-15T00:00:00Z");
    expect(approximateNote(until, 4)).toBe("approximate before Oct 15");
    expect(approximateNote(until, 0)).toBeNull();
    expect(approximateNote(null, 4)).toBeNull();
  });

  it("adds event counts to counters by label and counts bans per label", () => {
    const rows = ruleHitRows({
      counts: { dotenv: 100, "actuator": 3, "actuator-index": 2, gone: 1 },
      events: [{ path: "/.env", appId: null, count: 5 }, { path: "/.git/config", appId: null, count: 7 }],
      details: [
        { categories: [{ label: "env files", count: 3 }], paths: [], trapPath: null },
        { categories: [{ label: "env files", count: 1 }, { label: "Git metadata", count: 1 }], paths: [], trapPath: null },
        null,
      ],
    });
    expect(rows).toEqual([
      { label: "env files", hits: 105, bans: 2 },
      { label: "Git metadata", hits: 7, bans: 1 },
      { label: "Spring Boot Actuator", hits: 5, bans: 0 },
      { label: "other paths", hits: 1, bans: 0 },
    ]);
  });
});

describe("recording from the responder", () => {
  const KEY = "k".repeat(64);
  function run(path: string, recordHitDep: GuardDeps["recordHit"]) {
    const deps: GuardDeps = {
      hasKey: (v) => v === KEY,
      settings: async () => DEFAULT_INSTANCE_PROBE_GUARD,
      clientIp: async () => "203.0.113.50",
      recordHit: recordHitDep,
      ban: async () => ({ status: "refused", reason: "test" }),
      recordEvent: async () => {},
      markerFor: async () => ({ id: "c1", marker: "abcdefghjk23" }),
      activeMarkers: async () => [],
      markUsed: async () => {},
      appForHost: async () => null,
      robotsFor: renderAppRobots,
    };
    const headers = new Headers({ "x-replaced-path": path, host: "shop.example.com", "X-Vardo-Guard": KEY, "X-Vardo-Guard-App": "app1" });
    return handleGuardRequest("probe", new Request("http://console/probe-guard/probe", { headers }), deps);
  }

  it("counts the rule the path tripped", async () => {
    const spy = vi.fn(async () => 1);
    await run("/.env", spy);
    expect(spy).toHaveBeenCalledWith("203.0.113.50", "app1", 600_000, "dotenv");
  });

  it("answers when Redis is down", async () => {
    fake.ctl.down = true;
    const res = await run("/.env", (ip, appId, windowMs, ruleId) => recordHit(ip, appId, windowMs, ruleId));
    expect(res.status).toBe(404);
  });
});
