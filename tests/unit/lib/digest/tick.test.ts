import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_DIGEST, digestWindow, isDigestDue, scheduleFor, bucketStarts } from "@/lib/digest/window";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());

const mocks = vi.hoisted(() => ({ emit: vi.fn(), collect: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ emit: mocks.emit }));
vi.mock("@/lib/notifications/admin-orgs", () => ({ adminOrgIds: async () => ["org1"] }));
vi.mock("@/lib/time-zone-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/time-zone-settings")>()),
  getInstanceTimeZone: async () => "UTC",
}));
vi.mock("@/lib/digest/collector", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/digest/collector")>()),
  collectDigestData: mocks.collect,
}));

import { dbMock } from "@/tests/helpers/db";
import { backupRunRollup, hasActivity, scanRollup, topAlerts, windowLabel } from "@/lib/digest/collector";
import { EMAIL_FIXTURES, FIXTURE_CONTEXT } from "@/lib/email/fixtures";
import { renderNotificationEmail } from "@/lib/email/notification-email";
import type { DigestHealthEvent } from "@/lib/bus/events";
const { tickDigestJobs } = await import("@/lib/digest/tick");

// Monday, Oct 12 2026, 08:20 UTC.
const monday = new Date("2026-10-12T08:20:00Z");

describe("digestWindow", () => {
  it("covers yesterday for a daily digest, never part of today", () => {
    const w = digestWindow("daily", monday);
    expect(w.since.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(w.windowKey).toBe("daily:2026-10-11");
  });

  it("covers the seven full days before today for a weekly digest", () => {
    const w = digestWindow("weekly", monday);
    expect(w.since.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(w.until.toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(bucketStarts(w, 86_400_000)).toHaveLength(7);
  });

  it("keeps the same key for every tick in the window", () => {
    expect(digestWindow("weekly", monday).windowKey).toBe(digestWindow("weekly", new Date("2026-10-12T08:59:00Z")).windowKey);
  });

  it("labels a week and a day", () => {
    expect(windowLabel(digestWindow("weekly", monday))).toBe("Oct 5 – Oct 11, 2026");
    expect(windowLabel(digestWindow("daily", monday))).toBe("Oct 11, 2026");
  });
});

describe("isDigestDue", () => {
  it("defaults to weekly on Monday at 08:00 UTC", () => {
    expect(scheduleFor(undefined)).toEqual(DEFAULT_DIGEST);
    expect(isDigestDue(DEFAULT_DIGEST, monday)).toBe(true);
    expect(isDigestDue(DEFAULT_DIGEST, new Date("2026-10-13T08:20:00Z"))).toBe(false);
    expect(isDigestDue(DEFAULT_DIGEST, new Date("2026-10-12T09:00:00Z"))).toBe(false);
  });

  it("sends a daily digest every day at its hour", () => {
    const daily = { ...DEFAULT_DIGEST, cadence: "daily" as const };
    expect(isDigestDue(daily, new Date("2026-10-13T08:05:00Z"))).toBe(true);
  });

  it("never sends when switched off", () => {
    expect(isDigestDue({ ...DEFAULT_DIGEST, enabled: false }, monday)).toBe(false);
  });

  it("falls back to weekly for a cadence it doesn't know", () => {
    expect(scheduleFor({ enabled: true, cadence: "hourly", dayOfWeek: 1, hourOfDay: 8 }).cadence).toBe("weekly");
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

  it("puts scans and the last backup run in the digest email", async () => {
    const base = EMAIL_FIXTURES.find((f) => f.name === "digest-daily")!.event as DigestHealthEvent;
    const event: DigestHealthEvent = {
      ...base,
      backups: { ...base.backups, runs: 1, lastRunAt: "2026-10-11T09:04:00.000Z" },
      scans: { scanned: 14, apps: 14, lastRunAt: "2026-10-11T09:20:00.000Z", appsWithFindings: 0, critical: 0, warnings: 0 },
    };
    const email = (await renderNotificationEmail(event, { ...FIXTURE_CONTEXT, timeZone: "America/Los_Angeles" }))!;
    expect(email.text).toMatch(/Backups: .* · 1 run · last Oct 11, 02:04 PDT/);
    expect(email.text).toMatch(/Security scans: 14 apps scanned, no open issues · last Oct 11, 02:20 PDT/);
  });

  it("counts alerts by their registry label", () => {
    expect(topAlerts([{ type: "host.memory" }, { type: "app.oom" }, { type: "host.memory" }])).toEqual([
      { label: "Host memory", count: 2 },
      { label: "Killed for memory", count: 1 },
    ]);
  });
});

describe("tickDigestJobs", () => {
  beforeEach(() => {
    dbMock.reset();
    vi.clearAllMocks();
    dbMock.query.organizations.findMany.mockResolvedValue([{ id: "org1", name: "Acme" }]);
  });

  it("sends an org with no settings row on the default schedule", async () => {
    dbMock.query.digestSettings.findMany.mockResolvedValue([]);
    dbMock.updateReturns([{ id: "d1" }]);
    mocks.collect.mockResolvedValue({ deploys: { total: 3, succeeded: 3, failed: 0 }, backups: {}, cron: { failed: 0 }, alerts: { fired: 0, resolved: 0, open: 0 } });
    await tickDigestJobs(monday);
    expect(mocks.collect).toHaveBeenCalledWith("org1", "Acme", expect.objectContaining({ windowKey: "weekly:2026-10-05" }), expect.objectContaining({ withHost: true }));
    expect(mocks.emit).toHaveBeenCalledTimes(1);
    expect(mocks.emit.mock.calls[0][1].type).toBe("digest.health");
  });

  it("skips a window another process already claimed", async () => {
    dbMock.query.digestSettings.findMany.mockResolvedValue([]);
    dbMock.updateReturns([]);
    await tickDigestJobs(monday);
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("skips a window it already sent without touching the database", async () => {
    dbMock.query.digestSettings.findMany.mockResolvedValue([
      { organizationId: "org1", enabled: true, cadence: "weekly", dayOfWeek: 1, hourOfDay: 8, lastWindowKey: "weekly:2026-10-05" },
    ]);
    await tickDigestJobs(monday);
    expect(dbMock.updates).toHaveLength(0);
  });
});
