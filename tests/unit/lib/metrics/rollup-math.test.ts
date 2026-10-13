import { describe, expect, it } from "vitest";
import {
  HOUR_MS,
  SLOT_MS,
  buildHourRows,
  counterBytesByHour,
  histogramBucket,
  histogramPercentile,
  emptyHistogram,
  type RollupApp,
  type SlotSeries,
} from "@/lib/metrics/rollup-math";
import type { LabeledSeries } from "@/lib/metrics/resource-samples";

const H0 = Date.UTC(2026, 9, 1, 10);
const slot = (i: number) => H0 + i * SLOT_MS;

function series(container: string, project: string, points: [number, number][], service: string | null = null): LabeledSeries {
  return { key: `metrics:${project}:x:${container}`, project, service, container, points };
}

/** One value per slot index. */
function slots(values: Record<number, number>): [number, number][] {
  return Object.entries(values).map(([i, v]) => [slot(Number(i)), v]);
}

function every(value: number, from = 0, to = 12): Record<number, number> {
  const out: Record<number, number> = {};
  for (let i = from; i < to; i++) out[i] = value;
  return out;
}

function emptySeries(): SlotSeries {
  return { cpu: [], samples: [], memory: [], memoryLimit: [], networkRx: [], networkTx: [] };
}

const web: RollupApp = { id: "web-id", organizationId: "org", name: "web", parentAppId: null, composeService: null };
const stack: RollupApp = { id: "stack-id", organizationId: "org", name: "stack", parentAppId: null, composeService: null };
const stackDb: RollupApp = {
  id: "stack-db-id",
  organizationId: "org",
  name: "stack-db",
  parentAppId: "stack-id",
  composeService: "db",
  parentApp: { name: "stack" },
};

describe("buildHourRows", () => {
  it("averages CPU and memory over the hour and takes the busiest slot as the peak", () => {
    const s = emptySeries();
    s.cpu = [series("c1", "web", slots({ ...every(10), 4: 40 }))];
    s.samples = [series("c1", "web", slots(every(10)))];
    s.memory = [series("c1", "web", slots({ ...every(100), 7: 400 }))];
    s.memoryLimit = [series("c1", "web", slots(every(1000)))];

    const [row] = buildHourRows({ apps: [web], series: s, checks: [], fromMs: H0, toMs: H0 + HOUR_MS });

    expect(row).toMatchObject({
      appId: "web-id",
      organizationId: "org",
      hour: new Date(H0),
      metricMinutes: 60,
      sampleCount: 120,
      cpuAvg: 12.5,
      cpuPeak: 40,
      memoryAvg: 125,
      memoryPeak: 400,
      memoryLimit: 1000,
    });
  });

  it("sums containers per slot before averaging", () => {
    const s = emptySeries();
    s.cpu = [series("c1", "web", slots(every(10))), series("c2", "web", slots(every(30, 0, 6)))];
    s.memory = [series("c1", "web", slots(every(100))), series("c2", "web", slots(every(50, 0, 6)))];
    s.memoryLimit = [series("c1", "web", slots(every(1000))), series("c2", "web", slots(every(500, 0, 6)))];

    const [row] = buildHourRows({ apps: [web], series: s, checks: [], fromMs: H0, toMs: H0 + HOUR_MS });

    expect(row.cpuAvg).toBe(25);
    expect(row.cpuPeak).toBe(40);
    expect(row.memoryPeak).toBe(150);
    // The last slot has only c1.
    expect(row.memoryLimit).toBe(1000);
  });

  it("reports partial coverage and averages only over sampled slots", () => {
    const s = emptySeries();
    s.cpu = [series("c1", "web", slots(every(20, 0, 6)))];
    s.memory = [series("c1", "web", slots(every(100, 0, 6)))];

    const [row] = buildHourRows({ apps: [web], series: s, checks: [], fromMs: H0, toMs: H0 + HOUR_MS });

    expect(row.metricMinutes).toBe(30);
    expect(row.cpuAvg).toBe(20);
  });

  it("leaves the limit null when any container is unlimited", () => {
    const s = emptySeries();
    s.cpu = [series("c1", "web", slots(every(1))), series("c2", "web", slots(every(1)))];
    s.memoryLimit = [series("c1", "web", slots(every(1000))), series("c2", "web", slots(every(0)))];

    const [row] = buildHourRows({ apps: [web], series: s, checks: [], fromMs: H0, toMs: H0 + HOUR_MS });

    expect(row.memoryLimit).toBeNull();
  });

  it("writes no row for an hour with neither samples nor checks", () => {
    const s = emptySeries();
    s.cpu = [series("c1", "web", slots(every(10)))];

    const rows = buildHourRows({ apps: [web], series: s, checks: [], fromMs: H0, toMs: H0 + 3 * HOUR_MS });

    expect(rows.map((r) => r.hour.getTime())).toEqual([H0]);
  });

  it("gives a stack child its service and the parent only unclaimed services", () => {
    const s = emptySeries();
    s.cpu = [
      series("db1", "stack", slots(every(30)), "db"),
      series("app1", "stack", slots(every(5)), "app"),
      series("w1", "web", slots(every(1))),
    ];

    const rows = buildHourRows({ apps: [web, stack, stackDb], series: s, checks: [], fromMs: H0, toMs: H0 + HOUR_MS });
    const byApp = Object.fromEntries(rows.map((r) => [r.appId, r.cpuAvg]));

    expect(byApp).toEqual({ "web-id": 1, "stack-id": 5, "stack-db-id": 30 });
  });

  it("folds a slot-suffixed project into its app", () => {
    const s = emptySeries();
    s.cpu = [series("c1", "web-production-blue", slots(every(10)))];

    const [row] = buildHourRows({ apps: [web], series: s, checks: [], fromMs: H0, toMs: H0 + HOUR_MS });

    expect(row?.appId).toBe("web-id");
  });

  it("rolls domain checks into uptime and a response histogram", () => {
    const checks = [
      { appId: "web-id", checkedAt: new Date(H0 + 60_000), reachable: true, responseTimeMs: 120 },
      { appId: "web-id", checkedAt: new Date(H0 + 120_000), reachable: true, responseTimeMs: 800 },
      { appId: "web-id", checkedAt: new Date(H0 + 180_000), reachable: false, responseTimeMs: 10_000 },
      { appId: "web-id", checkedAt: new Date(H0 + HOUR_MS), reachable: true, responseTimeMs: 50 },
    ];

    const [row] = buildHourRows({ apps: [web], series: emptySeries(), checks, fromMs: H0, toMs: H0 + HOUR_MS });

    expect(row).toMatchObject({
      checksTotal: 3,
      checksUp: 2,
      responseCount: 2,
      responseMsSum: 920,
      metricMinutes: 0,
      cpuAvg: null,
      networkRxBytes: null,
    });
    const expected = emptyHistogram();
    expected[histogramBucket(120)] = 1;
    expected[histogramBucket(800)] = 1;
    expect(row.responseHistogram).toEqual(expected);
  });
});

describe("counterBytesByHour", () => {
  it("sums deltas, counts a reset's new reading and attributes each delta to its slot's hour", () => {
    const rx = series("c1", "web", [
      [H0 - SLOT_MS, 1000],
      [slot(0), 1100],
      [slot(1), 1300],
      [slot(2), 50],
      [slot(3), 150],
      [slot(11), 900],
      [H0 + HOUR_MS, 1000],
    ]);

    const bytes = counterBytesByHour([rx], H0, H0 + 2 * HOUR_MS);

    // 100 + 200 + 50 (reset) + 100; the 40-minute gap to slot 11 is dropped.
    expect(bytes.get(H0)).toBe(450);
    expect(bytes.get(H0 + HOUR_MS)).toBe(100);
  });

  it("ignores readings before the window but uses them as a baseline", () => {
    const rx = series("c1", "web", [[H0 - SLOT_MS, 500], [slot(0), 700]]);
    expect(counterBytesByHour([rx], H0, H0 + HOUR_MS).get(H0)).toBe(200);
    expect(counterBytesByHour([rx], H0 + HOUR_MS, H0 + 2 * HOUR_MS).size).toBe(0);
  });
});

describe("histogramPercentile", () => {
  it("interpolates inside the bucket that holds the rank", () => {
    const h = emptyHistogram();
    h[histogramBucket(150)] = 10;
    expect(histogramPercentile(h, 0.5)).toBe(150);
    expect(histogramPercentile(h, 0.95)).toBe(195);
  });

  it("spans buckets", () => {
    const h = emptyHistogram();
    h[histogramBucket(40)] = 90;
    h[histogramBucket(2500)] = 10;
    expect(histogramPercentile(h, 0.5)).toBeLessThanOrEqual(50);
    expect(histogramPercentile(h, 0.95)).toBe(2500);
  });

  it("reads the overflow bucket as its lower edge and an empty histogram as null", () => {
    const h = emptyHistogram();
    h[h.length - 1] = 3;
    expect(histogramPercentile(h, 0.5)).toBe(10_000);
    expect(histogramPercentile(emptyHistogram(), 0.5)).toBeNull();
  });
});
