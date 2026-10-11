import { describe, expect, it, vi } from "vitest";
import { KeyedCooldown } from "@/lib/net/cooldown";
import { ABUSEIPDB_CATEGORY_IDS, TEST_KEY_IP, abuseipdbCategories, createAbuseIpdbReporter } from "@/lib/probe-guard/reporting/abuseipdb";
import { draftReport, type DraftEvent } from "@/lib/probe-guard/reporting/draft";
import { drainReports, type DrainDeps } from "@/lib/probe-guard/reporting/drain";
import { DEDUPE_MS, SETTLE_MS, queueReport, type ReportQueueStore } from "@/lib/probe-guard/reporting/queue";
import { REPORT_CATEGORIES, ReportRateLimited, type AbuseReport, type AbuseReporter } from "@/lib/probe-guard/reporting/types";
import { DEFAULT_ABUSE_SETTINGS, normalizeAbuseSettings, type AbuseSettings } from "@/lib/probe-guard/abuse-settings";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";
import { PROBE_RULES } from "@/lib/probe-guard/rules";

const IP = "203.0.113.10";
const T0 = new Date("2026-03-01T12:00:00Z");
const WINDOW = 10 * 60_000;

function probe(path: string, offsetMs = -60_000, ip = IP): DraftEvent {
  return { ip, kind: "probe", path, createdAt: new Date(T0.getTime() + offsetMs) };
}

function draft(over: Partial<Parameters<typeof draftReport>[0]> = {}) {
  return draftReport({ ip: IP, ban: null, events: [], windowMs: WINDOW, now: T0, terms: [], ...over });
}

describe("category mapping", () => {
  it("maps every neutral category to a current AbuseIPDB id", () => {
    expect(Object.keys(ABUSEIPDB_CATEGORY_IDS).sort()).toEqual([...REPORT_CATEGORIES].sort());
    expect(ABUSEIPDB_CATEGORY_IDS).toEqual({ "web-attack": 21, hacking: 15, "bad-bot": 19, iot: 23 });
  });

  it("sends sorted, unique ids", () => {
    expect(abuseipdbCategories(["web-attack", "hacking", "web-attack"])).toBe("15,21");
  });

  it("maps exploit, router, credential, trap and canary evidence", () => {
    const ban = (reason: string) => ({ reason, createdAt: T0 });
    expect(draft({ events: [probe("/_ignition/execute-solution")] })?.categories).toEqual(["hacking", "web-attack"]);
    expect(draft({ events: [probe("/boaform/admin/formLogin")] })?.categories).toEqual(["hacking", "iot"]);
    expect(draft({ ban: ban("threshold"), events: [probe("/.env")] })?.categories).toEqual(["bad-bot", "web-attack"]);
    expect(draft({ ban: ban("trap"), events: [{ ip: IP, kind: "trap", path: "/admin-backup/", createdAt: T0 }] })?.categories).toEqual(["bad-bot", "web-attack"]);
    expect(draft({ ban: ban("canary") })?.categories).toEqual(["hacking", "web-attack"]);
  });

  it("marks the high-confidence rules reportable", () => {
    const flagged = Object.fromEntries(PROBE_RULES.filter((r) => r.report).map((r) => [r.id, r.report]));
    expect(flagged).toEqual({
      dotenv: "credentials",
      aws: "credentials",
      ssh: "credentials",
      phpunit: "exploit",
      ignition: "exploit",
      actuator: "exploit",
      traversal: "exploit",
      "router-exploits": "exploit",
    });
  });
});

describe("report eligibility", () => {
  it("reports exploit attempts without a ban", () => {
    expect(draft({ events: [probe("/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php")] })).not.toBeNull();
    expect(draft({ events: [probe("/../../etc/passwd")] })).not.toBeNull();
    expect(draft({ events: [probe("/actuator/heapdump")] })).not.toBeNull();
  });

  it("leaves bare /actuator discovery alone", () => {
    expect(draft({ events: [probe("/actuator")] })).toBeNull();
  });

  it("reports credential hunting only as part of a ban", () => {
    const events = [probe("/.env"), probe("/.aws/credentials"), probe("/.ssh/id_rsa")];
    expect(draft({ events })).toBeNull();
    expect(draft({ ban: { reason: "threshold", createdAt: T0 }, events })).not.toBeNull();
  });

  it("skips plain threshold bans made of non-reportable paths", () => {
    const events = [probe("/wp-login.php"), probe("/.git/config"), probe("/phpmyadmin/"), probe("/cgi-bin/x"), probe("/backup.sql")];
    expect(draft({ ban: { reason: "threshold", createdAt: T0 }, events })).toBeNull();
  });

  it("reports trap fetches and decoy use", () => {
    expect(draft({ ban: { reason: "trap", createdAt: T0 } })?.comment).toBe("Fetched a trap path");
    expect(draft({ ban: { reason: "canary", createdAt: T0 } })?.comment).toBe("Used a decoy credential");
  });

  it("never reports shared or blocklist bans on their own", () => {
    expect(draft({ ban: { reason: "mesh", createdAt: T0 } })).toBeNull();
    expect(draft({ ban: { reason: "blocklist", createdAt: T0 } })).toBeNull();
    expect(draft({ ban: { reason: "mesh", createdAt: T0 }, events: [probe("/.env")] })).toBeNull();
  });

  it("ignores other addresses' events and events outside the window", () => {
    expect(draft({ events: [probe("/_ignition/execute-solution", -60_000, "203.0.113.11")] })).toBeNull();
    expect(draft({ events: [probe("/_ignition/execute-solution", -2 * WINDOW)] })).toBeNull();
  });

  it("builds the comment from the ban summary", () => {
    const events = [
      ...Array.from({ length: 28 }, () => probe("/_ignition/execute-solution")),
      ...Array.from({ length: 6 }, () => probe("/.env")),
    ];
    const report = draft({ ban: { reason: "threshold", createdAt: T0 }, events });
    expect(report?.comment).toBe("Tried Laravel Ignition exploit (RCE) ×28, env files ×6. Paths: /_ignition/execute-solution, /.env");
  });
});

class MemoryStore implements ReportQueueStore {
  queue = new Map<string, number>();
  sent = new Map<string, number>();
  days = new Map<string, number>();
  constructor(private clock: () => number) {}
  async enqueue(ip: string, dueAt: number) {
    if (this.queue.has(ip)) return false;
    this.queue.set(ip, dueAt);
    return true;
  }
  async due(now: number, limit: number) {
    return [...this.queue].filter(([, at]) => at <= now).sort((a, b) => a[1] - b[1]).slice(0, limit).map(([ip]) => ip);
  }
  async remove(ip: string) {
    return this.queue.delete(ip);
  }
  async requeue(ip: string, dueAt: number) {
    this.queue.set(ip, dueAt);
  }
  async dropBefore(at: number) {
    for (const [ip, due] of this.queue) if (due < at) this.queue.delete(ip);
  }
  async recentlyReported(ip: string) {
    return (this.sent.get(ip) ?? 0) > this.clock();
  }
  async markReported(ip: string, ttlMs: number) {
    this.sent.set(ip, this.clock() + ttlMs);
  }
  async reserveDaily(day: string, cap: number) {
    const n = (this.days.get(day) ?? 0) + 1;
    if (n > cap) return false;
    this.days.set(day, n);
    return true;
  }
  async releaseDaily(day: string) {
    this.days.set(day, (this.days.get(day) ?? 1) - 1);
  }
  async dailyCount(day: string) {
    return this.days.get(day) ?? 0;
  }
}

function harness(over: { settings?: Partial<AbuseSettings["reporting"]>; reporter?: Partial<AbuseReporter>; ctx?: DrainDeps["neverBanContext"] } = {}) {
  let now = T0.getTime();
  const clock = () => now;
  const store = new MemoryStore(clock);
  const sent: AbuseReport[] = [];
  const statuses: { error: string | null }[] = [];
  const recorded: string[] = [];
  const reporter: AbuseReporter = {
    id: "abuseipdb",
    label: "AbuseIPDB",
    report: async (r) => {
      sent.push(r);
    },
    testKey: async () => ({ ok: true }),
    ...over.reporter,
  };
  const settings: AbuseSettings = { ...DEFAULT_ABUSE_SETTINGS, reporting: { enabled: true, dailyCap: 500, ...over.settings } };
  const deps: DrainDeps = {
    store,
    cooldown: new KeyedCooldown({ baseMs: 60_000, maxMs: 3_600_000, maxHoldMs: 24 * 3_600_000 }),
    reporter,
    settings: async () => settings,
    apiKey: async () => "k".repeat(80),
    neverBanContext: over.ctx ?? (async () => ({})),
    draft: async (ip) => ({ report: { ip, categories: ["web-attack"], comment: "Tried path traversal ×1" }, appId: null }),
    recordReported: async (ip) => {
      recorded.push(ip);
    },
    setStatus: async (s) => {
      statuses.push(s);
    },
    now: clock,
  };
  const enqueue = (ip: string) => queueReport(ip, { store, enabled: async () => settings.reporting.enabled, now: clock });
  return { deps, store, sent, statuses, recorded, enqueue, advance: (ms: number) => (now += ms), clock };
}

describe("report queue", () => {
  it("waits for the settle delay before sending", async () => {
    const h = harness();
    await h.enqueue(IP);
    expect((await drainReports(h.deps)).sent).toBe(0);
    h.advance(SETTLE_MS);
    expect((await drainReports(h.deps)).sent).toBe(1);
    expect(h.recorded).toEqual([IP]);
  });

  it("rechecks never-ban addresses at send time", async () => {
    let allow: string[] = [];
    const h = harness({ ctx: async () => ({ allowlist: allow }) });
    await h.enqueue(IP);
    allow = [IP];
    h.advance(SETTLE_MS);
    const result = await drainReports(h.deps);
    expect(result).toMatchObject({ sent: 0, skipped: 1 });
    expect(h.sent).toEqual([]);
  });

  it("refuses private addresses even when queued", async () => {
    const h = harness();
    await h.store.enqueue("10.0.0.5", 0);
    expect((await drainReports(h.deps)).sent).toBe(0);
  });

  it("reports an address at most once per 15 minutes", async () => {
    const h = harness();
    await h.enqueue(IP);
    h.advance(SETTLE_MS);
    await drainReports(h.deps);
    expect(await h.enqueue(IP)).toBe(false);
    await h.store.enqueue(IP, h.clock());
    expect((await drainReports(h.deps)).skipped).toBe(1);
    h.advance(DEDUPE_MS);
    expect(await h.enqueue(IP)).toBe(true);
    h.advance(SETTLE_MS);
    expect((await drainReports(h.deps)).sent).toBe(1);
    expect(h.sent).toHaveLength(2);
  });

  it("stops at the daily cap and keeps the rest for later", async () => {
    const h = harness({ settings: { dailyCap: 2 } });
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) await h.enqueue(ip);
    h.advance(SETTLE_MS);
    const result = await drainReports(h.deps);
    expect(result).toMatchObject({ sent: 2, deferred: 1 });
    expect(h.store.queue.has("203.0.113.3")).toBe(true);
    h.advance(24 * 3_600_000);
    await h.store.requeue("203.0.113.3", h.clock());
    expect((await drainReports(h.deps)).sent).toBe(1);
  });

  it("defaults the cap to 500, under the free tier's 1,000", () => {
    expect(DEFAULT_ABUSE_SETTINGS.reporting.dailyCap).toBe(500);
  });

  it("backs off on 429 for the Retry-After and keeps the entry", async () => {
    let calls = 0;
    const h = harness({
      reporter: {
        report: async () => {
          calls++;
          throw new ReportRateLimited("Daily rate limit of 1000 requests exceeded", 3_600_000, false);
        },
      },
    });
    await h.enqueue(IP);
    h.advance(SETTLE_MS);
    const first = await drainReports(h.deps);
    expect(first.deferred).toBe(1);
    expect(h.statuses.at(-1)?.error).toMatch(/Daily rate limit/);
    expect(h.store.queue.has(IP)).toBe(true);
    expect(await h.deps.cooldown.remaining("abuseipdb", h.clock())).toBeGreaterThanOrEqual(3_600_000);
    h.advance(30 * 60_000);
    await drainReports(h.deps);
    expect(calls).toBe(1);
    expect(await h.store.dailyCount("2026-03-01")).toBe(0);
  });

  it("treats a per-address 429 as already reported", async () => {
    const h = harness({
      reporter: {
        report: async () => {
          throw new ReportRateLimited("You can only report the same IP address once in 15 minutes.", null, true);
        },
      },
    });
    await h.enqueue(IP);
    h.advance(SETTLE_MS);
    expect((await drainReports(h.deps)).skipped).toBe(1);
    expect(await h.store.recentlyReported(IP)).toBe(true);
    expect(await h.deps.cooldown.remaining("abuseipdb", h.clock())).toBe(0);
  });

  it("does nothing while reporting is off", async () => {
    const h = harness({ settings: { enabled: false } });
    expect(await h.enqueue(IP)).toBe(false);
    await h.store.enqueue(IP, 0);
    expect((await drainReports(h.deps)).sent).toBe(0);
  });
});

describe("toggles", () => {
  it("default off", () => {
    expect(DEFAULT_ABUSE_SETTINGS.reporting.enabled).toBe(false);
    expect(DEFAULT_ABUSE_SETTINGS.blocklists.abuseipdb.enabled).toBe(false);
    expect(DEFAULT_ABUSE_SETTINGS.blocklists.spamhaus.enabled).toBe(false);
    expect(normalizeAbuseSettings(null)).toEqual(DEFAULT_ABUSE_SETTINGS);
    expect(normalizeAbuseSettings({ reporting: { enabled: "yes" } })).toEqual(DEFAULT_ABUSE_SETTINGS);
  });

  it("holds the confidence threshold at 75 or more, default 90", () => {
    expect(DEFAULT_ABUSE_SETTINGS.blocklists.abuseipdb.minConfidence).toBe(90);
    expect(normalizeAbuseSettings({ blocklists: { abuseipdb: { enabled: true, minConfidence: 50 } } })).toEqual(DEFAULT_ABUSE_SETTINGS);
    expect(normalizeAbuseSettings({ blocklists: { abuseipdb: { enabled: true, minConfidence: 75 } } }).blocklists.abuseipdb.minConfidence).toBe(75);
  });

  it("leaves the probe guard's own settings untouched", () => {
    expect(Object.keys(DEFAULT_INSTANCE_PROBE_GUARD)).not.toContain("reporting");
  });
});

describe("AbuseIPDB reporter", () => {
  function response(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  }
  const report: AbuseReport = { ip: IP, categories: ["web-attack", "hacking"], comment: "Tried path traversal ×1" };

  it("posts the form AbuseIPDB expects", async () => {
    const fetchMock = vi.fn(async () => response(200, { data: { ipAddress: IP, abuseConfidenceScore: 100 } }));
    await createAbuseIpdbReporter({ fetch: fetchMock as unknown as typeof fetch }).report(report, "secret-key");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.abuseipdb.com/api/v2/report");
    expect((init.headers as Record<string, string>).Key).toBe("secret-key");
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({ ip: IP, categories: "15,21", comment: "Tried path traversal ×1" });
  });

  it("waits out a short Retry-After, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429, { errors: [{ detail: "Too many requests", status: 429 }] }, { "Retry-After": "7" }))
      .mockResolvedValueOnce(response(200, { data: {} }));
    await createAbuseIpdbReporter({ fetch: fetchMock as unknown as typeof fetch, sleep }).report(report, "k");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThanOrEqual(7000);
  });

  it("hands a long Retry-After back to the queue", async () => {
    const fetchMock = vi.fn(async () => response(429, { errors: [{ detail: "Daily rate limit of 1000 requests exceeded" }] }, { "Retry-After": "7200" }));
    const err = await createAbuseIpdbReporter({ fetch: fetchMock as unknown as typeof fetch, sleep: async () => {} })
      .report(report, "k")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReportRateLimited);
    expect(err.retryAfterMs).toBe(7_200_000);
    expect(err.perAddress).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tests a key against a documentation address", async () => {
    const fetchMock = vi.fn(async () => response(200, { data: { ipAddress: TEST_KEY_IP } }));
    expect(await createAbuseIpdbReporter({ fetch: fetchMock as unknown as typeof fetch }).testKey("k")).toEqual({ ok: true });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get("ipAddress")).toBe("198.51.100.1");
    const rejected = vi.fn(async () => response(401, { errors: [{ detail: "Authentication failed" }] }));
    expect(await createAbuseIpdbReporter({ fetch: rejected as unknown as typeof fetch }).testKey("bad")).toMatchObject({ ok: false });
  });
});
