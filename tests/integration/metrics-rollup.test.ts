// Hourly rollup against a scratch Postgres and an in-memory time-series store.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";

type Sample = [number, number];
type FakeSeries = { key: string; labels: Record<string, string>; points: Sample[] };

const store = vi.hoisted(() => ({ series: [] as FakeSeries[], calls: 0 }));

/** TS.MRANGE over `store`: FILTER metric=, SELECTED_LABELS, ALIGN 0 and avg/count/max/last aggregation. */
function fakeMrange(args: string[]): unknown {
  const from = Number(args[0]);
  const to = Number(args[1]);
  const at = (flag: string) => args.indexOf(flag);
  const agg = args[at("AGGREGATION") + 1]!;
  const bucket = Number(args[at("AGGREGATION") + 2]);
  const metric = args[at("FILTER") + 1]!.split("=")[1];
  if (at("ALIGN") > at("SELECTED_LABELS")) throw new Error("SELECTED_LABELS swallows ALIGN");
  const labels = args.slice(at("SELECTED_LABELS") + 1, at("FILTER"));

  return store.series
    .filter((s) => s.labels.metric === metric)
    .map((s) => {
      const buckets = new Map<number, number[]>();
      for (const [ts, v] of s.points) {
        if (ts < from || ts > to) continue;
        const b = Math.floor(ts / bucket) * bucket;
        buckets.set(b, [...(buckets.get(b) ?? []), v]);
      }
      const points = [...buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([b, vs]) => {
          const value =
            agg === "avg" ? vs.reduce((x, y) => x + y, 0) / vs.length
            : agg === "count" ? vs.length
            : agg === "max" ? Math.max(...vs)
            : vs[vs.length - 1]!;
          return [b, String(value)];
        });
      return [s.key, labels.map((l) => [l, s.labels[l] ?? null]), points];
    });
}

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/shutdown", () => ({ closeOnShutdown: () => () => {} }));
vi.mock("@/lib/config/features", () => ({ isFeatureEnabled: () => true }));
vi.mock("@/lib/metrics/ts-client", () => ({
  RETENTION_MS: 7 * 24 * 60 * 60_000,
  tsRedis: {
    call: async (cmd: string, ...args: string[]) => {
      if (cmd !== "TS.MRANGE") throw new Error(`unexpected ${cmd}`);
      store.calls++;
      return fakeMrange(args);
    },
  },
}));

const conn = await connectScratchServer();

const HOUR = 60 * 60_000;
const SAMPLE_MS = 30_000;
// 12:05 UTC; the last completed hour starts at 11:00.
const NOW = Date.UTC(2026, 9, 10, 12, 5);

/** A container sampled every 30s over [from, to): steady CPU and memory, counters climbing 1000 and 500 a sample. */
function addContainer(
  project: string,
  container: string,
  from: number,
  to: number,
  opts: { service?: string; cpu?: number; environment?: string } = {},
) {
  const base = {
    project,
    container,
    ...(opts.service ? { service: opts.service } : {}),
    ...(opts.environment ? { environment: opts.environment } : {}),
  };
  const metrics: Record<string, (i: number) => number> = {
    cpu: () => opts.cpu ?? 10,
    memory: () => 100_000_000,
    memoryLimit: () => 512_000_000,
    networkRx: (i) => 1000 * (i + 1),
    networkTx: (i) => 500 * (i + 1),
  };
  for (const [metric, value] of Object.entries(metrics)) {
    const points: Sample[] = [];
    let i = 0;
    for (let ts = from; ts < to; ts += SAMPLE_MS) points.push([ts, value(i++)]);
    store.series.push({ key: `metrics:${project}:${metric}:${container}`, labels: { ...base, metric }, points });
  }
}

describe.skipIf(!conn)("metrics rollup on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("rollup");
  let sql: ReturnType<typeof postgres>;
  let rollup: typeof import("@/lib/metrics/rollup");
  let history: typeof import("@/lib/metrics/history");
  let client: typeof import("@/lib/uptime/client");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    const migrated = await runMigrate(url);
    expect(migrated.code, migrated.out).toBe(0);
    process.env.DATABASE_URL = url;
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('org', 'Org', 'org')`;
    await sql`insert into project (id, organization_id, name, display_name) values ('proj', 'org', 'default', 'Default')`;
    await sql`insert into app (id, organization_id, name, display_name, project_id) values
      ('web', 'org', 'web', 'Web', 'proj'),
      ('stack', 'org', 'stack', 'Stack', 'proj')`;
    await sql`insert into app (id, organization_id, name, display_name, project_id, parent_app_id, compose_service)
      values ('stack-db', 'org', 'stack-db', 'Stack DB', 'proj', 'stack', 'db')`;
    await sql`insert into domain (id, app_id, domain) values ('d1', 'web', 'web.example.com')`;
    await sql`insert into uptime_monitor (id, organization_id, name, "check", source, app_id, domain_id) values ('mon-d1', 'org', 'web.example.com', '{"type":"http","url":"https://web.example.com","expectedStatus":{"min":100,"max":499},"timeoutMs":10000}', 'auto', 'web', 'd1')`;
    rollup = await import("@/lib/metrics/rollup");
    history = await import("@/lib/metrics/history");
    client = await import("@/lib/uptime/client");
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(async () => {
    store.series = [];
    store.calls = 0;
    await sql`delete from app_metric_hour`;
    await sql`delete from uptime_result`;
    await sql`delete from system_settings where key = ${rollup.WATERMARK_KEY}`;
  });

  const rows = (appId: string) =>
    sql<{ hour: Date; metric_minutes: number; sample_count: number; cpu_avg: number; memory_avg: string; network_rx_bytes: string; network_tx_bytes: string; checks_total: number; checks_up: number; response_count: number }[]>`
      select * from app_metric_hour where app_id = ${appId} order by hour`;

  it("rolls up a day of samples and checks into hourly rows", async () => {
    addContainer("web", "c1", NOW - 26 * HOUR, NOW);
    for (let ts = NOW - 2 * HOUR - 5 * 60_000; ts < NOW - 5 * 60_000; ts += 5 * 60_000) {
      const down = ts === NOW - HOUR - 5 * 60_000;
      await sql`insert into uptime_result (monitor_id, vantage_id, path, at, ok, latency_ms)
        values ('mon-d1', 'local', 'local', ${new Date(ts)}, ${!down}, 200)`;
    }

    const result = await rollup.rollupHours({ now: NOW });

    expect(result.toMs).toBe(Date.UTC(2026, 9, 10, 12));
    const web = await rows("web");
    // Samples start at 10:05 the day before: 25 whole hours plus a partial one.
    expect(web).toHaveLength(26);
    const full = web.find((r) => r.hour.getTime() === Date.UTC(2026, 9, 10, 9))!;
    expect(full).toMatchObject({ metric_minutes: 60, sample_count: 120, cpu_avg: 10 });
    expect(Number(full.memory_avg)).toBe(100_000_000);
    expect(Number(full.network_rx_bytes)).toBe(120_000);
    expect(Number(full.network_tx_bytes)).toBe(60_000);
    expect(web[0]).toMatchObject({ metric_minutes: 55 });

    const lastHour = web.find((r) => r.hour.getTime() === Date.UTC(2026, 9, 10, 11))!;
    expect(lastHour).toMatchObject({ checks_total: 12, checks_up: 11, response_count: 11 });
    // First run backfills raw retention: seven 24-hour chunks of six reads.
    expect(store.calls).toBe(42);
  });

  it("re-running the same hours writes the same rows", async () => {
    addContainer("web", "c1", NOW - 6 * HOUR, NOW);
    await rollup.rollupHours({ now: NOW });
    const first = (await rows("web")).map(({ updated_at: _u, ...r }: Record<string, unknown>) => r);

    await rollup.rollupHours({ now: NOW });
    await rollup.rollupHours({ now: NOW + 10 * 60_000 });
    const again = (await rows("web")).map(({ updated_at: _u, ...r }: Record<string, unknown>) => r);

    expect(again).toEqual(first);
  });

  it("keeps stack children and their parent disjoint", async () => {
    addContainer("stack", "db1", NOW - 2 * HOUR, NOW, { service: "db", cpu: 30 });
    addContainer("stack", "app1", NOW - 2 * HOUR, NOW, { service: "app", cpu: 5 });

    await rollup.rollupHours({ now: NOW });

    const [parent] = await rows("stack");
    const [child] = await rows("stack-db");
    expect(parent?.cpu_avg).toBe(5);
    expect(child?.cpu_avg).toBe(30);
  });

  it("counts only the default environment's containers and domains", async () => {
    addContainer("web", "prod", NOW - 2 * HOUR, NOW, { environment: "production", cpu: 10 });
    addContainer("web", "preview", NOW - 2 * HOUR, NOW, { environment: "pr-4", cpu: 70 });
    addContainer("web", "staging", NOW - 2 * HOUR, NOW, { environment: "staging", cpu: 20 });
    await sql`insert into environment (id, app_id, name, type, is_default, domain) values
      ('env-prod', 'web', 'production', 'production', true, null),
      ('env-stg', 'web', 'staging', 'staging', false, 'staging.web.example.com')`;
    await sql`insert into domain (id, app_id, domain) values ('d-stg', 'web', 'staging.web.example.com')`;
    await sql`insert into uptime_monitor (id, organization_id, name, "check", source, app_id, domain_id) values ('mon-stg', 'org', 'staging.web.example.com', '{"type":"http","url":"https://staging.web.example.com","expectedStatus":{"min":100,"max":499},"timeoutMs":10000}', 'auto', 'web', 'd-stg')`;
    const at = new Date(NOW - HOUR + 60_000);
    await sql`insert into uptime_result (monitor_id, vantage_id, path, at, ok, latency_ms, error) values
      ('mon-d1', 'local', 'local', ${at}, true, 100, null),
      ('mon-stg', 'local', 'local', ${at}, false, 0, null),
      ('mon-d1', 'other-vantage', 'public', ${at}, false, 0, null),
      ('mon-d1', 'local', 'local', ${new Date(NOW - HOUR + 120_000)}, false, 0, 'blocked')`;

    try {
      await rollup.rollupHours({ now: NOW });
      const last = (await rows("web")).find((r) => r.hour.getTime() === NOW - HOUR - 5 * 60_000)!;
      expect(last).toMatchObject({ cpu_avg: 10, checks_total: 1, checks_up: 1 });
    } finally {
      await sql`delete from uptime_monitor where id = 'mon-stg'`;
      await sql`delete from domain where id = 'd-stg'`;
      await sql`delete from environment`;
    }
  });

  it("catches up on hours missed while down, from the watermark", async () => {
    addContainer("web", "c1", NOW - 3 * HOUR, NOW + 10 * HOUR);
    await rollup.rollupHours({ now: NOW });
    expect(await rows("web")).toHaveLength(3);

    // Down for nine hours; the next pass fills all of them.
    const later = NOW + 9 * HOUR;
    const result = await rollup.rollupHours({ now: later });

    expect(result.fromMs).toBe(Date.UTC(2026, 9, 10, 12));
    const web = await rows("web");
    expect(web.map((r) => r.hour.getTime())).toEqual(
      Array.from({ length: 12 }, (_, i) => Date.UTC(2026, 9, 10, 9 + i)),
    );
  });

  it("leaves a gap in samples as a gap and reports it as coverage", async () => {
    // Collector down from 06:00 to 09:30.
    addContainer("web", "c1", Date.UTC(2026, 9, 10, 0), Date.UTC(2026, 9, 10, 6));
    addContainer("web", "c1b", Date.UTC(2026, 9, 10, 9, 30), NOW);

    await rollup.rollupHours({ now: NOW });

    const hours = (await rows("web")).map((r) => r.hour.getUTCHours());
    expect(hours).not.toContain(6);
    expect(hours).not.toContain(8);

    const summary = await history.appSummary("org", "web", {
      from: new Date(Date.UTC(2026, 9, 10, 0)),
      to: new Date(Date.UTC(2026, 9, 10, 12)),
    });
    // 00:00-06:00 and 09:30-12:00 sampled: 510 of 720 minutes.
    expect(summary.coverage).toEqual({ minutes: 510, expectedMinutes: 720, ratio: 510 / 720 });
    expect(summary.cpu?.avg).toBe(10);
  });

  it("starts no earlier than raw retention after a long outage", async () => {
    await sql`insert into system_settings (key, value) values (${rollup.WATERMARK_KEY}, ${new Date(NOW - 30 * 24 * HOUR).toISOString()})`;
    const result = await rollup.rollupHours({ now: NOW });
    expect(result.fromMs).toBe(Math.ceil((NOW - 7 * 24 * HOUR) / HOUR) * HOUR);
  });

  it("prunes rows older than thirteen months and keeps the boundary hour", async () => {
    const cutoff = rollup.rollupCutoff(NOW);
    expect(cutoff.toISOString()).toBe("2025-09-10T12:00:00.000Z");
    for (const hour of [new Date(cutoff.getTime() - HOUR), cutoff, new Date(NOW - HOUR)]) {
      await sql`insert into app_metric_hour (app_id, organization_id, hour) values ('web', 'org', ${hour})`;
    }

    expect(await rollup.pruneRollups(NOW)).toBe(1);

    const left = (await rows("web")).map((r) => r.hour.toISOString());
    expect(left).toEqual([cutoff.toISOString(), new Date(NOW - HOUR).toISOString()]);
  });

  it("reads the newest checks of each domain from uptime, not the newest overall", async () => {
    await sql`insert into domain (id, app_id, domain) values ('d-quiet', 'web', 'quiet.example.com')`;
    await sql`insert into uptime_monitor (id, organization_id, name, "check", source, app_id, domain_id) values ('mon-quiet', 'org', 'quiet.example.com', '{"type":"http","url":"https://quiet.example.com","expectedStatus":{"min":100,"max":499},"timeoutMs":10000}', 'auto', 'web', 'd-quiet')`;
    try {
      for (let i = 0; i < 15; i++) {
        await sql`insert into uptime_result (monitor_id, vantage_id, path, at, ok, latency_ms) values ('mon-d1', 'local', 'local', ${new Date(NOW - i * 60_000)}, true, 50)`;
      }
      for (let i = 0; i < 3; i++) {
        await sql`insert into uptime_result (monitor_id, vantage_id, path, at, ok, latency_ms) values ('mon-quiet', 'local', 'local', ${new Date(NOW - HOUR - i * 60_000)}, true, 50)`;
      }

      const checks = await client.uptimeClient.recentDomainChecks("org", ["d1", "d-quiet"], 10);

      expect(checks.filter((c) => c.domainId === "d1")).toHaveLength(10);
      expect(checks.filter((c) => c.domainId === "d-quiet")).toHaveLength(3);
      expect(checks[0]!.checkedAt).toBe(new Date(NOW).toISOString());
      expect(await client.uptimeClient.recentDomainChecks("org", [], 10)).toEqual([]);
      expect(await client.uptimeClient.recentDomainChecks("other-org", ["d1"], 10)).toEqual([]);
    } finally {
      await sql`delete from uptime_monitor where id = 'mon-quiet'`;
      await sql`delete from domain where id = 'd-quiet'`;
    }
  });

  it("serves summaries, hour-of-day and daily reads from the rows", async () => {
    addContainer("web", "c1", NOW - 48 * HOUR, NOW);
    await rollup.rollupHours({ now: NOW });
    const window = { from: new Date(Date.UTC(2026, 9, 9)), to: new Date(Date.UTC(2026, 9, 10)) };

    const summaries = await history.appSummaries("org", window);
    expect([...summaries.keys()]).toEqual(["web"]);
    expect(summaries.get("web")).toMatchObject({
      hours: 24,
      coverage: { ratio: 1 },
      cpu: { avg: 10 },
      network: { rxBytes: 24 * 120_000, txBytes: 24 * 60_000 },
      uptime: null,
    });

    const profile = await history.appHourOfDay("org", "web", window);
    expect(profile.every((b) => b.sampledHours === 1 && b.rxBytes === 120_000)).toBe(true);

    const days = await history.appDailySeries("org", "web", window);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ date: "2026-10-09", cpuAvg: 10, coverage: { ratio: 1 } });

    expect(await history.loadHistoryRows("other-org", window)).toEqual([]);
  });
});
