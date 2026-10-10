// A job failing every 10 minutes alerts once, then once more when it recovers.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  settings: vi.fn(),
  rows: new Map<string, { sentAt: Date; clearedAt: Date | null; severity: string; detail: unknown }>(),
}));

vi.mock("@/lib/notifications/dispatch", () => ({ emit: mocks.emit }));
vi.mock("@/lib/notifications/preferences", () => ({ readOrgNotificationSettings: mocks.settings }));
// notification_send in memory, judged by the real claimable rule.
vi.mock("@/lib/notifications/throttle", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/notifications/throttle")>();
  const key = (org: string, type: string, about: string) => `${org}|${type}|${about}`;
  return {
    ...real,
    claimNotifications: async (
      org: string,
      type: string,
      requests: { about: string; severity: "warning" | "critical"; detail: unknown }[],
      minHours: number,
      now: Date,
    ) => {
      const claims = [];
      for (const r of requests) {
        const existing = mocks.rows.get(key(org, type, r.about)) ?? null;
        if (!real.claimable(existing, r.severity, now, minHours)) continue;
        mocks.rows.set(key(org, type, r.about), { sentAt: now, clearedAt: null, severity: r.severity, detail: r.detail });
        claims.push({ about: r.about, previous: existing });
      }
      return claims;
    },
    clearNotifications: async (org: string, type: string, _holding: string[], now: Date, only?: string[]) => {
      const cleared = [];
      for (const about of only ?? []) {
        const row = mocks.rows.get(key(org, type, about));
        if (!row || row.clearedAt) continue;
        row.clearedAt = now;
        cleared.push({ about, severity: row.severity, sentAt: row.sentAt, detail: row.detail });
      }
      return cleared;
    },
  };
});

const { cronFailureItem, noteCronFailure, noteCronSuccess } = await import("@/lib/cron/alerts");

const job = { id: "job-1", name: "Site cron", organizationId: "org-1", app: null };
const event = {
  title: "Cron failed: Site cron",
  message: "GET https://example.com/wp-cron.php → 500",
  cronJobId: "job-1",
  cronJobName: "Site cron",
  durationMs: 120,
};
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 9, 12, minutes));
const sent = (type: string) => mocks.emit.mock.calls.filter(([, e]) => e.type === type);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.clear();
  mocks.settings.mockResolvedValue({ categories: { cron: true } });
});

describe("cron failure alerts", () => {
  it("sends once for a streak of failures and once on recovery", async () => {
    for (const minute of [0, 10, 20, 30, 40, 50]) {
      await noteCronFailure(job, event, at(minute));
    }
    expect(sent("cron.failed")).toHaveLength(1);

    await noteCronSuccess(job, at(59));
    expect(sent("alert.resolved")).toHaveLength(1);
    expect(sent("alert.resolved")[0][1].alerts[0]).toMatchObject({ type: "cron.failure", about: "job-1" });

    await noteCronSuccess(job, at(59));
    expect(sent("alert.resolved")).toHaveLength(1);
  });

  it("stays quiet when a job fails again inside the hour after recovering", async () => {
    await noteCronFailure(job, event, at(0));
    await noteCronSuccess(job, at(10));
    await noteCronFailure(job, event, at(20));
    expect(sent("cron.failed")).toHaveLength(1);
  });

  it("sends nothing on success when nothing was failing", async () => {
    await noteCronSuccess(job, at(0));
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("sends nothing when the org turned cron alerts off", async () => {
    mocks.settings.mockResolvedValue({ categories: { cron: false } });
    await noteCronFailure(job, event, at(0));
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it("keys the throttle per job", async () => {
    await noteCronFailure(job, event, at(0));
    await noteCronFailure({ ...job, id: "job-2" }, { ...event, cronJobId: "job-2" }, at(0));
    expect(sent("cron.failed")).toHaveLength(2);
  });
});

describe("cron alert titles", () => {
  it("names the app the job runs on", () => {
    const item = cronFailureItem({ ...job, name: "WP Cron", app: { id: "app_1", name: "shop", displayName: "Shop" } }, "HTTP 521", at(0));
    expect(item.title).toBe("WP Cron is failing on Shop");
    expect(item.facts).toContainEqual({ label: "Job", value: "WP Cron" });
  });

  it("keeps the job's name alone for an org-level job", () => {
    expect(cronFailureItem(job, "HTTP 500", at(0)).title).toBe("Cron job Site cron is failing");
  });
});
