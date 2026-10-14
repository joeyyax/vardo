import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_DIGEST, dayStarts, digestWindow, frequencyFor, isDigestDue, scheduleFor } from "@/lib/digest/window";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const mocks = vi.hoisted(() => ({ send: vi.fn(), collect: vi.fn(), watches: vi.fn(), watched: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: mocks.send }));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: async () => ["org1"] }));
vi.mock("@/lib/notifications/mail-context", () => ({ mailContext: async () => ({ baseUrl: "https://vardo.example.com", instanceName: "node-a", timeZone: "UTC" }) }));
vi.mock("@/lib/recaps/collect", () => ({ volumeSizes: async () => new Map() }));
vi.mock("@/lib/digest/watch", () => ({ watchesByUser: mocks.watches, collectWatchedProject: mocks.watched }));
vi.mock("@/lib/time-zone-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/time-zone-settings")>()),
  getInstanceTimeZone: async () => "UTC",
}));
vi.mock("@/lib/digest/collector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/digest/collector")>()),
  collectDigestData: mocks.collect,
}));

import { dbMock } from "@/tests/helpers/db";
import { backupRunRollup, deployChanges, hasActivity, scanRollup, staleByApp, topAlerts, windowLabel } from "@/lib/digest/collector";
import { EMAIL_FIXTURES } from "@/lib/email/fixtures";
import type { DigestHealthEvent } from "@/lib/bus/events";
const { dueMembers, tickDigestJobs } = await import("@/lib/digest/tick");

// Monday, Oct 12 2026, 08:20 UTC.
const monday = new Date("2026-10-12T08:20:00Z");
// Sunday, Nov 1 2026, 08:20 UTC.
const first = new Date("2026-11-01T08:20:00Z");

const fixture = (name: string) => EMAIL_FIXTURES.find((f) => f.name === name)!.event as DigestHealthEvent;
const { type: _type, title: _title, message: _message, ...weeklyData } = fixture("digest-weekly");
const watchedProject = fixture("digest-watching").watched![0]!;

describe("digestWindow", () => {
  it("covers the seven full days before today for a weekly digest", () => {
    const w = digestWindow("weekly", monday);
    expect(w.since.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(w.windowKey).toBe("weekly:2026-10-05");
    expect(dayStarts(w)).toHaveLength(7);
  });

  it("covers last calendar month for a monthly digest", () => {
    const w = digestWindow("monthly", first);
    expect(w.since.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(w.windowKey).toBe("monthly:2026-10");
    expect(dayStarts(w)).toHaveLength(31);
  });

  it("crosses a year", () => {
    const w = digestWindow("monthly", new Date("2027-01-01T08:00:00Z"));
    expect(w.windowKey).toBe("monthly:2026-12");
    expect(windowLabel(w)).toBe("December 2026");
  });

  it("keeps the same key for every tick in the window", () => {
    expect(digestWindow("weekly", monday).windowKey).toBe(digestWindow("weekly", new Date("2026-10-12T08:59:00Z")).windowKey);
    expect(digestWindow("monthly", first).windowKey).toBe(digestWindow("monthly", new Date("2026-11-01T08:59:00Z")).windowKey);
  });

  it("labels a week", () => {
    expect(windowLabel(digestWindow("weekly", monday))).toBe("Oct 5 – Oct 11, 2026");
  });
});

describe("frequency scheduling", () => {
  it("defaults to weekly on Monday at 08:00", () => {
    expect(scheduleFor(undefined)).toEqual(DEFAULT_DIGEST);
    expect(isDigestDue(DEFAULT_DIGEST, "weekly", monday)).toBe(true);
    expect(isDigestDue(DEFAULT_DIGEST, "weekly", new Date("2026-10-13T08:20:00Z"))).toBe(false);
    expect(isDigestDue(DEFAULT_DIGEST, "weekly", new Date("2026-10-12T09:00:00Z"))).toBe(false);
  });

  it("sends monthly on the 1st only, whatever the weekday", () => {
    expect(isDigestDue(DEFAULT_DIGEST, "monthly", first)).toBe(true);
    expect(isDigestDue(DEFAULT_DIGEST, "monthly", monday)).toBe(false);
    expect(isDigestDue(DEFAULT_DIGEST, "weekly", first)).toBe(false);
  });

  it("never sends when the org switches digests off", () => {
    expect(isDigestDue({ ...DEFAULT_DIGEST, enabled: false }, "weekly", monday)).toBe(false);
    expect(isDigestDue({ ...DEFAULT_DIGEST, enabled: false }, "monthly", first)).toBe(false);
  });

  it("gives a person with no preference the weekly digest", () => {
    expect(frequencyFor(undefined)).toBe("weekly");
    expect(frequencyFor({ frequency: "monthly" })).toBe("monthly");
    expect(frequencyFor({ frequency: "daily" })).toBe("weekly");
  });

  it("picks only the members on the window's cadence who haven't had it", () => {
    const members = ["weekly", "monthly", "off", "none", "sent"].map((userId) => ({ userId, email: `${userId}@example.com` }));
    const prefs = new Map([
      ["weekly", { frequency: "weekly", lastWindowKey: null }],
      ["monthly", { frequency: "monthly", lastWindowKey: null }],
      ["off", { frequency: "off", lastWindowKey: null }],
      ["sent", { frequency: "weekly", lastWindowKey: "weekly:2026-10-05" }],
    ]);
    expect(dueMembers(members, prefs, digestWindow("weekly", monday)).map((m) => m.userId)).toEqual(["weekly", "none"]);
    expect(dueMembers(members, prefs, digestWindow("monthly", first)).map((m) => m.userId)).toEqual(["monthly"]);
  });
});

describe("digest content", () => {
  const empty = {
    deploys: { total: 0, succeeded: 0, failed: 0 },
    backups: { succeeded: 0, failed: 0, totalSize: 0, drillsPassed: 0, drillsFailed: 0, staleVolumes: 0 },
    cron: { failed: 0, affectedJobs: [] },
    alerts: { fired: 0, resolved: 0, open: 0, top: [] },
  };

  it("stays silent for a window where nothing happened", () => {
    expect(hasActivity(empty)).toBe(false);
    expect(hasActivity({ ...empty, alerts: { ...empty.alerts, open: 1 } })).toBe(true);
  });

  it("sends for a window where only scans ran, to say they found nothing new", () => {
    expect(hasActivity({ ...empty, scans: { scanned: 12, apps: 12, lastRunAt: null, appsWithFindings: 0, critical: 0, warnings: 0 } })).toBe(true);
  });

  it("rolls scans up by each app's latest result", () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 11, h));
    const rollup = scanRollup([
      { appId: "a", status: "completed", criticalCount: 1, warningCount: 0, startedAt: at(2), completedAt: at(2) },
      { appId: "a", status: "completed", criticalCount: 0, warningCount: 1, startedAt: at(3), completedAt: at(3) },
      { appId: "b", status: "completed", criticalCount: 0, warningCount: 0, startedAt: at(2), completedAt: at(2) },
      { appId: "c", status: "failed", criticalCount: 0, warningCount: 0, startedAt: at(4), completedAt: at(4) },
    ]);
    expect(rollup).toEqual({ scanned: 3, apps: 2, lastRunAt: at(3).toISOString(), appsWithFindings: 1, critical: 0, warnings: 1 });
  });

  it("counts backup runs and when the last one ended", () => {
    const end = new Date(Date.UTC(2026, 9, 11, 2, 4));
    expect(backupRunRollup([{ finishedAt: new Date(Date.UTC(2026, 9, 10, 2, 3)) }, { finishedAt: end }])).toEqual({ runs: 2, lastRunAt: end.toISOString() });
    expect(backupRunRollup([])).toEqual({ runs: 0, lastRunAt: null });
  });

  it("counts alerts by their registry label", () => {
    expect(topAlerts([{ type: "host.memory" }, { type: "app.oom" }, { type: "host.memory" }])).toEqual([
      { label: "Host memory", count: 2 },
      { label: "Killed for memory", count: 1 },
    ]);
  });

  it("groups stale volumes by app, most first", () => {
    expect(staleByApp([{ appId: "a", appName: "gitea" }, { appId: "b", appName: "ntfy" }, { appId: "a", appName: "gitea" }])).toEqual([
      { appId: "a", appName: "gitea", volumes: 2 },
      { appId: "b", appName: "ntfy", volumes: 1 },
    ]);
  });

  it("lists what a deploy taught an app, not its first three days or live alerts", () => {
    const w = digestWindow("monthly", first);
    const at = (iso: string) => Date.parse(iso);
    const items = [
      { kind: "port" as const, item: "tcp/8443", state: "known", first: at("2026-10-19T17:00:00Z") },
      { kind: "port" as const, item: "tcp/9000", state: "flagged", first: at("2026-10-20T17:00:00Z") },
      { kind: "process" as const, item: "node", state: "known", first: at("2026-10-02T12:00:00Z") },
      { kind: "process" as const, item: "old", state: "known", first: at("2026-09-02T12:00:00Z") },
    ];
    expect(deployChanges(items, w, null).map((i) => i.item)).toEqual(["node", "tcp/8443"]);
    expect(deployChanges(items, w, new Date("2026-10-01T12:00:00Z")).map((i) => i.item)).toEqual(["tcp/8443"]);
  });
});

describe("tickDigestJobs", () => {
  const members = [
    { userId: "u1", email: "one@example.com" },
    { userId: "u2", email: "two@example.com" },
  ];

  beforeEach(() => {
    dbMock.reset();
    vi.clearAllMocks();
    dbMock.query.organizations.findMany.mockResolvedValue([{ id: "org1", name: "Acme Studio", timeZone: "UTC" }]);
    dbMock.query.digestSettings.findMany.mockResolvedValue([]);
    dbMock.selectReturns(members);
    mocks.collect.mockResolvedValue(weeklyData);
    mocks.watches.mockResolvedValue(new Map());
    mocks.send.mockResolvedValue({ success: true });
  });

  it("emails each member on the default weekly frequency once, claimed first", async () => {
    dbMock.updateReturns([{ userId: "u1" }, { userId: "u2" }]);
    await tickDigestJobs(monday);
    expect(mocks.collect).toHaveBeenCalledWith("org1", "Acme Studio", expect.objectContaining({ windowKey: "weekly:2026-10-05" }), expect.objectContaining({ withHost: true }));
    expect(mocks.collect).toHaveBeenCalledTimes(1);
    expect(dbMock.updates[0]!.set).toMatchObject({ lastWindowKey: "weekly:2026-10-05" });
    expect(mocks.send.mock.calls.map((c) => c[0].to)).toEqual(["one@example.com", "two@example.com"]);
    expect(mocks.send.mock.calls[0][0].subject).toBe("node-a · Week of Oct 5 in Acme Studio · 2 need you");
  });

  it("sends nothing to a member who turned it off", async () => {
    dbMock.query.userDigestPreferences.findMany.mockResolvedValue([
      { userId: "u1", frequency: "off", lastWindowKey: null },
      { userId: "u2", frequency: "off", lastWindowKey: null },
    ]);
    await tickDigestJobs(monday);
    await tickDigestJobs(first);
    expect(dbMock.updates).toHaveLength(0);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("sends a monthly member on the 1st and not on the weekly day", async () => {
    dbMock.query.userDigestPreferences.findMany.mockResolvedValue([{ userId: "u1", frequency: "monthly", lastWindowKey: null }]);
    dbMock.selectReturns([members[0]]);
    dbMock.updateReturns([{ userId: "u1" }]);
    await tickDigestJobs(monday);
    expect(mocks.send).not.toHaveBeenCalled();
    mocks.collect.mockResolvedValue({ ...weeklyData, cadence: "monthly", windowLabel: "October 2026" });
    await tickDigestJobs(first);
    expect(mocks.collect).toHaveBeenCalledWith("org1", "Acme Studio", expect.objectContaining({ windowKey: "monthly:2026-10" }), expect.anything());
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].text).toContain("Sent monthly.");
  });

  it("never sends a window twice: a claimed window or one already recorded is skipped", async () => {
    dbMock.updateReturns([]);
    await tickDigestJobs(monday);
    expect(mocks.collect).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();

    dbMock.query.userDigestPreferences.findMany.mockResolvedValue([
      { userId: "u1", frequency: "weekly", lastWindowKey: "weekly:2026-10-05" },
      { userId: "u2", frequency: "weekly", lastWindowKey: "weekly:2026-10-05" },
    ]);
    const before = dbMock.updates.length;
    await tickDigestJobs(monday);
    expect(dbMock.updates).toHaveLength(before);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("only emails the members the claim returned", async () => {
    dbMock.updateReturns([{ userId: "u2" }]);
    await tickDigestJobs(monday);
    expect(mocks.send.mock.calls.map((c) => c[0].to)).toEqual(["two@example.com"]);
  });

  it("adds a watched project's detail to that member's digest only", async () => {
    dbMock.updateReturns([{ userId: "u1" }, { userId: "u2" }]);
    mocks.watches.mockResolvedValue(new Map([["u1", ["proj_mowp"]]]));
    mocks.watched.mockResolvedValue(watchedProject);
    await tickDigestJobs(monday);
    const [one, two] = mocks.send.mock.calls.map((c) => c[0]);
    expect(one.text).toContain("Watching MOWP");
    expect(one.text).toContain("mowp-2026-docs (docs.example.org)");
    expect(one.text).toContain("You're watching MOWP.");
    expect(two.text).not.toContain("MOWP");
  });

  it("skips a window where nothing happened", async () => {
    dbMock.updateReturns([{ userId: "u1" }, { userId: "u2" }]);
    mocks.collect.mockResolvedValue({ ...weeklyData, deploys: { total: 0, succeeded: 0, failed: 0 }, backups: { ...weeklyData.backups, succeeded: 0, failed: 0, drillsPassed: 0, drillsFailed: 0 }, cron: { failed: 0, affectedJobs: [] }, alerts: { fired: 0, resolved: 0, open: 0, top: [] }, scans: undefined });
    await tickDigestJobs(monday);
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
