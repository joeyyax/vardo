import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-in for RedisTimeSeries: TS.CREATE records labels, TS.ADD appends
// samples, TS.MRANGE selects by label equality. Enough to prove writes and reads
// agree on the same key shape.
const fake = vi.hoisted(() => {
  type Series = { key: string; labels: Record<string, string>; points: [number, number][] };
  const series = new Map<string, Series>();

  function mrange(args: string[]) {
    const filterAt = args.indexOf("FILTER");
    const filters = args.slice(filterAt + 1).map((f) => {
      const [key, value] = f.split("=");
      return { key, value };
    });
    return [...series.values()]
      .filter((s) => filters.every((f) => s.labels[f.key] === f.value))
      .map((s) => [
        s.key,
        Object.entries(s.labels).map(([k, v]) => [k, v]),
        s.points.map(([ts, val]) => [String(ts), String(val)]),
      ]);
  }

  return {
    series,
    reset: () => series.clear(),
    tsKey: (project: string, metric: string, container?: string) =>
      container ? `metrics:${project}:${metric}:${container}` : `metrics:${project}:${metric}`,
    ensureTimeSeries: async (key: string, labels: Record<string, string>) => {
      if (!series.has(key)) series.set(key, { key, labels, points: [] });
    },
    call: async (...args: string[]) => {
      const [command, ...rest] = args;
      if (command === "TS.ADD") {
        const [key, ts, value] = rest;
        series.get(key)?.points.push([Number(ts), Number(value)]);
        return ts;
      }
      if (command === "TS.MRANGE") return mrange(rest);
      return [];
    },
  };
});

vi.mock("@/lib/metrics/ts-client", () => ({
  tsKey: fake.tsKey,
  ensureTimeSeries: fake.ensureTimeSeries,
  tsRedis: { call: fake.call },
  RETENTION_MS: 0,
  getTsClient: () => null,
}));

import { appSeriesScope } from "@/lib/metrics/series-scope";
import { storeMetrics, queryMetrics } from "@/lib/metrics/store-container";

// paperless is the deployed stack; every container carries vardo.project=paperless
// and is told apart only by com.docker.compose.service.
const parent = {
  name: "paperless",
  parentAppId: null,
  composeService: null,
  parentApp: null,
};

const child = {
  name: "paperless-paperless-db",
  parentAppId: "parent-id",
  composeService: "paperless-db",
  parentApp: { name: "paperless" },
};

async function seedStack() {
  await storeMetrics("paperless", "c-db", "paperless-production-green-paperless-db-1", 1000, {
    cpuPercent: 5,
    memoryUsage: 100,
    memoryLimit: 1000,
    networkRxBytes: 10,
    networkTxBytes: 20,
  }, "org-1", "paperless-db");

  await storeMetrics("paperless", "c-web", "paperless-production-green-webserver-1", 1000, {
    cpuPercent: 30,
    memoryUsage: 900,
    memoryLimit: 1000,
    networkRxBytes: 40,
    networkTxBytes: 50,
  }, "org-1", "webserver");
}

describe("appSeriesScope", () => {
  it("reads a top-level app under its own name with no service filter", () => {
    expect(appSeriesScope(parent)).toEqual({ project: "paperless", service: null });
  });

  it("reads a stack child under its parent, narrowed by compose service", () => {
    expect(appSeriesScope(child)).toEqual({ project: "paperless", service: "paperless-db" });
  });

  it("falls back to the app's own name when the parent wasn't loaded", () => {
    expect(appSeriesScope({ ...child, parentApp: null })).toEqual({
      project: "paperless-paperless-db",
      service: "paperless-db",
    });
  });
});

describe("stored series scope", () => {
  beforeEach(() => fake.reset());

  it("labels each container's series with its compose service", async () => {
    await seedStack();
    const db = fake.series.get("metrics:paperless:cpu:c-db");
    expect(db?.labels).toMatchObject({ project: "paperless", service: "paperless-db" });
  });

  it("returns a stack child's own history, not the whole stack's", async () => {
    await seedStack();
    const scope = appSeriesScope(child);

    const points = await queryMetrics(scope.project, "cpu", 0, 2000, undefined, scope.service);

    expect(points).toEqual([[1000, 5]]);
  });

  it("returns every service for the parent app", async () => {
    await seedStack();
    const scope = appSeriesScope(parent);

    const points = await queryMetrics(scope.project, "cpu", 0, 2000, undefined, scope.service);

    expect(points).toEqual([[1000, 35]]);
  });

  it("finds nothing when a child is queried under its own name", async () => {
    await seedStack();

    const points = await queryMetrics(child.name, "cpu", 0, 2000);

    expect(points).toEqual([]);
  });
});
