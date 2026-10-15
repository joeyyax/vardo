import { beforeEach, describe, expect, it, vi } from "vitest";
import { apps, notificationSends, organizations } from "@/lib/db/schema";
import { SAMPLE_MS } from "@/lib/anomaly/baseline";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const now = Date.UTC(2026, 9, 15, 12, 0);

const mocks = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
  quiet: new Set<string>(),
  at: 0,
  samples: [] as { at: number; value: number }[],
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const chain = {
          leftJoin: () => chain,
          where: () => chain,
          then: (resolve: (v: unknown[]) => unknown) => Promise.resolve(mocks.rows.get(table) ?? []).then(resolve),
        };
        return chain;
      },
    }),
  },
}));
vi.mock("@/lib/metrics/broadcast", () => ({ getLatestSnapshot: () => [{ timestamp: mocks.at }] }));
vi.mock("@/lib/metrics/app-match", () => ({ groupMetricsByApp: () => new Map() }));
vi.mock("@/lib/time-zone-settings", () => ({ getInstanceTimeZone: async () => "UTC", resolveTimeZone: () => "UTC" }));
vi.mock("@/lib/anomaly/store", () => ({
  appendSample: async () => {},
  forgetSeen: async () => {},
  resetPidsSamples: async () => {},
  learningSince: async () => 0,
  readSeen: async () => new Map(),
  writeSeen: async () => {},
  readSamples: async () => mocks.samples,
}));
vi.mock("@/lib/anomaly/suppress", () => ({
  activityWindows: async () => [],
  recentWorkWindows: async () => [],
  markActivity: () => {},
  quietApps: () => mocks.quiet,
}));
vi.mock("@/lib/anomaly/probe", () => ({ appPorts: () => ({ action: "keep" }), probeContainer: async () => ({ processes: [], ports: [] }) }));
vi.mock("@/lib/notifications/observations", () => ({ settleAlerts: async () => {} }));

const { anomalyObservations, GAP_HOLD_MS } = await import("@/lib/anomaly/pass");

const alert = { type: "app.anomaly", about: "a1", severity: "critical", title: "Grafana is running far more processes than usual", detail: "" };

type Globals = { __vardo_anomaly?: { coveredAt: Map<string, number>; baselines: Map<string, unknown> } };

beforeEach(() => {
  const s = (globalThis as unknown as Globals).__vardo_anomaly;
  s?.coveredAt.clear();
  s?.baselines.clear();
  mocks.quiet = new Set();
  mocks.samples = [];
  mocks.rows = new Map<unknown, unknown[]>([
    [apps, [{ id: "a1", name: "Grafana", displayName: "Grafana", status: "active", parentAppId: null, organizationId: "o1", anomalyAlerts: true, stack: null, stackAnomalyAlerts: null }]],
    [organizations, [{ id: "o1", timeZone: null, sensitivity: "normal" }]],
    [notificationSends, [{ organizationId: "o1", type: "app.anomaly", about: "a1", detail: alert }]],
  ]);
});

/** Held observations for the alert, with the snapshot and clock at `at`. */
const held = async (at: number) => (mocks.at = at, await anomalyObservations(at))?.get("o1")?.filter((o) => o.type === "app.anomaly" && o.about === "a1") ?? [];

describe("open anomaly alert with nothing to judge", () => {
  it("clears once every baseline stays cold past the gap hold", async () => {
    expect(await held(now)).toHaveLength(1);
    expect(await held(now + GAP_HOLD_MS - MIN)).toHaveLength(1);
    expect(await held(now + GAP_HOLD_MS + MIN)).toHaveLength(0);
  });

  it("holds while the app is quiet, however long", async () => {
    mocks.quiet = new Set(["a1"]);
    expect(await held(now)).toHaveLength(1);
    expect(await held(now + 3 * GAP_HOLD_MS)).toHaveLength(1);
  });

  it("restarts the gap clock when quiet ends", async () => {
    mocks.quiet = new Set(["a1"]);
    await held(now);
    await held(now + 2 * GAP_HOLD_MS);
    mocks.quiet = new Set();
    expect(await held(now + 2 * GAP_HOLD_MS + 5 * MIN)).toHaveLength(1);
    expect(await held(now + 3 * GAP_HOLD_MS + MIN)).toHaveLength(0);
  });

  it("holds through a brief reading gap with warm baselines, then clears", async () => {
    mocks.samples = Array.from({ length: (7 * DAY) / SAMPLE_MS }, (_, i) => ({ at: now - i * SAMPLE_MS, value: 100 }));
    expect(await held(now)).toHaveLength(1);
    expect(await held(now + 5 * MIN)).toHaveLength(1);
    expect(await held(now + GAP_HOLD_MS + MIN)).toHaveLength(0);
  });
});
