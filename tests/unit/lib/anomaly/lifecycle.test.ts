import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertItem } from "@/lib/bus/events";

vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());

type Row = { sentAt: Date; clearedAt: Date | null; severity: string; detail: unknown };

const mocks = vi.hoisted(() => ({ emit: vi.fn(), rows: new Map<string, Row>() }));

vi.mock("@/lib/notifications/dispatch", () => ({ emit: mocks.emit }));
vi.mock("@/lib/notifications/preferences", () => ({
  readOrgNotificationSettings: async () => ({ categories: { anomalies: true, apps: true, host: true, backups: true, cron: true } }),
}));
vi.mock("@/lib/notifications/throttle", async () => {
  const actual = await vi.importActual<typeof import("@/lib/notifications/throttle")>("@/lib/notifications/throttle");
  return {
    claimNotifications: async (_org: string, _type: string, requests: { about: string; severity: "warning" | "critical"; detail: unknown }[], minHours: number, now: Date) =>
      requests.flatMap((r) => {
        const existing = mocks.rows.get(r.about) ?? null;
        if (!actual.claimable(existing, r.severity, now, minHours)) return [];
        mocks.rows.set(r.about, { sentAt: now, clearedAt: null, severity: r.severity, detail: r.detail });
        return [{ about: r.about, previous: existing }];
      }),
    clearNotifications: async (_org: string, _type: string, holding: string[], now: Date) =>
      [...mocks.rows].flatMap(([about, row]) => {
        if (row.clearedAt || holding.includes(about)) return [];
        row.clearedAt = now;
        return [{ about, severity: row.severity, sentAt: row.sentAt, detail: row.detail }];
      }),
  };
});

const { notifyObservations } = await import("@/lib/notifications/observations");
const { AnomalyEngine } = await import("@/lib/anomaly/engine");
const { anomalyItem } = await import("@/lib/anomaly/items");
const { SAMPLE_MS, computeBaseline, utcOffset } = await import("@/lib/anomaly/baseline");

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const start = Date.UTC(2026, 9, 7, 12, 0);
const app = { id: "a1", name: "Shop" };

// A week of steady 100 B/s egress.
const history = Array.from({ length: (7 * DAY) / SAMPLE_MS }, (_, i) => ({ at: start - i * SAMPLE_MS, value: 100 }));
const egressBaseline = computeBaseline(history, start);

/** One pass a minute: record, judge, notify. */
async function simulate(engine: InstanceType<typeof AnomalyEngine>, from: number, egressPerSec: number[]) {
  for (const [i, egress] of egressPerSec.entries()) {
    const now = from + i * MIN;
    engine.record(app.id, { egress }, now, false);
    const result = engine.evaluate(app.id, { egress: egressBaseline }, {
      now,
      sensitivity: "normal",
      offset: utcOffset,
      quiet: false,
    });
    const item = result.state === "judged" && result.findings.length > 0 ? anomalyItem(app, result.findings, null) : null;
    const fires = result.state === "judged" && result.findings.some((f) => f.verdict.fires);
    const observations = item ? [{ type: "app.anomaly" as const, about: app.id, severity: item.severity, fires, item }] : [];
    await notifyObservations("org1", ["app.anomaly"], observations, new Date(now));
  }
}

const repeat = (value: number, n: number) => Array.from({ length: n }, () => value);

beforeEach(() => {
  mocks.emit.mockReset();
  mocks.rows.clear();
});

describe("anomaly episode", () => {
  it("alerts once, holds through the episode and resolves when it settles", async () => {
    const MiBps = 1024 ** 2 / 60;
    await simulate(new AnomalyEngine(), start, [...repeat(100, 20), ...repeat(50 * MiBps, 40), ...repeat(100, 20)]);

    const events = mocks.emit.mock.calls.map(([, e]) => e);
    expect(events.map((e) => e.type)).toEqual(["alert.fired", "alert.resolved"]);

    const [fired] = events[0].alerts as AlertItem[];
    expect(fired).toMatchObject({ type: "app.anomaly", appId: "a1", severity: "critical", title: "Shop is sending far more traffic than usual" });
    expect(fired.detail).toMatch(/compromised/);
    expect(fired.facts?.[0]).toEqual({ label: "Outbound traffic", value: "50 MiB/min now, typically 5.9 KiB/min" });
    expect(Date.parse(fired.since!)).toBe(start + 20 * MIN);
  });

  it("sends nothing while the app stays inside its normal range", async () => {
    await simulate(new AnomalyEngine(), start, repeat(150, 60));
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
