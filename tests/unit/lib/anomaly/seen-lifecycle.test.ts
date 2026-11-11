import { beforeEach, describe, expect, it, vi } from "vitest";
import { apps, notificationSends, organizations } from "@/lib/db/schema";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const start = Date.UTC(2026, 9, 10, 12, 0);

const mocks = vi.hoisted(() => ({
  rows: new Map<unknown, unknown[]>(),
  metrics: new Map<string, unknown[]>(),
  processes: [] as string[],
  ports: [] as string[],
  settle: vi.fn(async (..._args: unknown[]) => {}),
}));

/** An in-memory Redis with expiry on a settable clock. */
const r = vi.hoisted(() => {
  const data = new Map<string, Map<string, string> | string>();
  const expires = new Map<string, number>();
  const self = { clock: 0, data, expires };
  const live = (k: string) => {
    const at = expires.get(k);
    if (at !== undefined && at <= self.clock) {
      data.delete(k);
      expires.delete(k);
    }
    return data.get(k);
  };
  const hash = (k: string) => {
    const h = live(k);
    if (h instanceof Map) return h;
    const fresh = new Map<string, string>();
    data.set(k, fresh);
    return fresh;
  };
  const cmds: Record<string, (...a: never[]) => unknown> = {
    get: (k: string) => {
      const v = live(k);
      return typeof v === "string" ? v : null;
    },
    set: (k: string, v: string) => (data.set(k, v), expires.delete(k), "OK"),
    del: (k: string) => (data.delete(k), expires.delete(k), 1),
    hgetall: (k: string) => {
      const h = live(k);
      return h instanceof Map ? Object.fromEntries(h) : {};
    },
    hget: (k: string, f: string) => {
      const h = live(k);
      return h instanceof Map ? (h.get(f) ?? null) : null;
    },
    hset: (k: string, ...a: (string | Record<string, string>)[]) => {
      const h = hash(k);
      if (typeof a[0] === "object") for (const [f, v] of Object.entries(a[0])) h.set(f, v);
      else h.set(a[0], a[1] as string);
      return 1;
    },
    hsetnx: (k: string, f: string, v: string) => {
      const h = hash(k);
      if (h.has(f)) return 0;
      h.set(f, v);
      return 1;
    },
    hdel: (k: string, ...fields: string[]) => {
      const h = live(k);
      if (!(h instanceof Map)) return 0;
      for (const f of fields) h.delete(f);
      if (h.size === 0) cmds.del(k as never);
      return fields.length;
    },
    expire: (k: string, s: number) => {
      if (!live(k)) return 0;
      expires.set(k, self.clock + s * 1000);
      return 1;
    },
    scan: (_cursor: string, _match: string, pattern: string) => ["0", [...data.keys()].filter((k) => live(k) && k.startsWith(pattern.slice(0, -1)))],
  };
  const client: Record<string, unknown> = Object.fromEntries(Object.entries(cmds).map(([n, f]) => [n, async (...a: never[]) => f(...a)]));
  client.pipeline = () => {
    const ops: [string, never[]][] = [];
    const pipe: Record<string, unknown> = new Proxy({}, {
      get: (_, name: string) =>
        name === "exec"
          ? async () => ops.map(([n, a]) => [null, cmds[n](...a)])
          : (...a: never[]) => (ops.push([name, a]), pipe),
    });
    return pipe;
  };
  return Object.assign(self, { client });
});

vi.mock("@/lib/redis", () => ({ redis: r.client }));
vi.mock("@/lib/metrics/ts-client", () => ({
  tsRedis: { call: async (cmd: string) => (cmd === "TS.RANGE" || cmd === "TS.QUERYINDEX" ? [] : "OK") },
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
vi.mock("@/lib/metrics/broadcast", () => ({ getLatestSnapshot: () => [{ timestamp: r.clock }] }));
vi.mock("@/lib/metrics/app-match", () => ({ groupMetricsByApp: () => mocks.metrics }));
vi.mock("@/lib/time-zone-settings", () => ({ getInstanceTimeZone: async () => "UTC", resolveTimeZone: () => "UTC" }));
vi.mock("@/lib/anomaly/suppress", () => ({
  activityWindows: async () => [],
  recentWorkWindows: async () => [],
  markActivity: () => {},
  quietApps: () => new Set(),
}));
vi.mock("@/lib/anomaly/probe", async (orig) => ({
  ...(await orig<typeof import("@/lib/anomaly/probe")>()),
  probeContainer: async () => ({
    processes: mocks.processes.map((name, i) => ({ pid: i + 1, name, cpu: 0, rssKb: 0 })),
    ports: mocks.ports,
    hostNetwork: false,
    sharedNetwork: false,
  }),
}));
vi.mock("@/lib/notifications/observations", () => ({ settleAlerts: mocks.settle }));

const { anomalyObservations } = await import("@/lib/anomaly/pass");
const { repairLostSeen } = await import("@/lib/anomaly/store");

type Globals = { __vardo_anomaly?: { seen: Map<string, unknown>; probedAt: Map<string, number>; top: Map<string, unknown>; seenRepaired: boolean } };
const state = () => (globalThis as unknown as Globals).__vardo_anomaly!;

const appRow = (id: string, name: string) => ({ id, name, displayName: name, status: "active", parentAppId: null, organizationId: "o1", anomalyAlerts: true, stack: null, stackAnomalyAlerts: null });
const metric = { containerId: "c1", containerIdFull: "c1", timestamp: 0, cpuPercent: 0, processCount: 1, networkRxBytes: 0, networkTxBytes: 0, diskWriteBytes: 0 };

/** One pass at `at`; returns the titles of new process and port findings. */
async function pass(at: number): Promise<string[]> {
  r.clock = at;
  const out = await anomalyObservations(at);
  return (out?.get("o1") ?? []).filter((o) => o.type !== "app.anomaly").map((o) => o.item.title);
}

/** Drops the in-process allow-set cache, as a console restart does. */
const restart = () => state().seen.clear();

const entries = (key: string) => {
  const h = r.data.get(key);
  return h instanceof Map ? Object.fromEntries(h) : null;
};

beforeEach(() => {
  r.data.clear();
  r.expires.clear();
  const s = state();
  if (s) {
    s.seen.clear();
    s.probedAt.clear();
    s.top.clear();
  }
  mocks.settle.mockClear();
  mocks.processes = ["nginx"];
  mocks.ports = ["tcp/80"];
  mocks.metrics = new Map([["a1", [metric]]]);
  mocks.rows = new Map<unknown, unknown[]>([
    [apps, [appRow("a1", "Web")]],
    [organizations, [{ id: "o1", timeZone: null, sensitivity: "normal" }]],
  ]);
});

describe("allow-set lifetime", () => {
  it("keeps a stable app's allow-sets alive past 30 days of unchanged probes", async () => {
    for (let at = start; at <= start + 40 * DAY; at += 6 * HOUR) expect(await pass(at)).toEqual([]);
    restart();
    expect(await pass(start + 40 * DAY + HOUR)).toEqual([]);
    expect(await pass(start + 40 * DAY + 2 * HOUR)).toEqual([]);
    expect(entries("vardo:anomaly:procs:a1")).toEqual({ nginx: `k:${start}` });
    expect(entries("vardo:anomaly:ports:a1")).toEqual({ "tcp/80": `k:${start}` });
  });

  it.each([
    ["was evicted", () => r.data.delete("vardo:anomaly:procs:a1")],
    ["expired before the fix", () => {
      r.data.delete("vardo:anomaly:procs:a1");
      (r.data.get("vardo:anomaly:meta:a1") as Map<string, string>).delete("known:procs");
    }],
  ])("relearns a lost set without flagging when it %s", async (_, lose) => {
    await pass(start);
    await pass(start + 4 * DAY);
    lose();
    restart();
    mocks.processes = ["nginx", "worker"];
    expect(await pass(start + 4 * DAY + HOUR)).toEqual([]);
    expect(await pass(start + 4 * DAY + 2 * HOUR)).toEqual([]);
    expect(entries("vardo:anomaly:procs:a1")).toEqual({ nginx: `k:${start + 4 * DAY + HOUR}`, worker: `k:${start + 4 * DAY + HOUR}` });
  });

  it("flags a new process in a healthy set on its second sample", async () => {
    await pass(start);
    mocks.processes = ["nginx", "xmrig"];
    expect(await pass(start + 4 * DAY)).toEqual([]);
    expect(await pass(start + 4 * DAY + HOUR)).toEqual(["Web started a new process, xmrig, without a deploy"]);
  });

  it("still flags the first port of an app that never listened", async () => {
    mocks.ports = [];
    await pass(start);
    await pass(start + 4 * DAY);
    restart();
    mocks.ports = ["tcp/4444"];
    expect(await pass(start + 4 * DAY + HOUR)).toEqual([]);
    expect(await pass(start + 4 * DAY + 2 * HOUR)).toEqual(["Web opened tcp/4444 without a deploy"]);
  });
});

describe("allow-set repair", () => {
  const now = Date.UTC(2026, 10, 11, 22, 0);
  const flaggedAt = now - 30 * MIN;

  beforeEach(() => {
    state().seenRepaired = false;
    mocks.metrics = new Map();
    mocks.rows.set(apps, [appRow("a1", "qBittorrent"), appRow("a2", "Postgres")]);
    mocks.rows.set(notificationSends, [
      { organizationId: "o1", type: "app.new-process", about: "a1", detail: null },
      { organizationId: "o1", type: "app.new-port", about: "a1", detail: null },
      { organizationId: "o1", type: "app.new-process", about: "a2", detail: null },
    ]);
    r.data.set("vardo:anomaly:meta:a1", new Map([["learningSince", String(start)]]));
    r.data.set("vardo:anomaly:meta:a2", new Map([["learningSince", String(start)]]));
    r.data.set("vardo:anomaly:procs:a1", new Map([
      ["s6-svscan", `f:${flaggedAt - 25 * MIN}:${flaggedAt}`],
      ["qbittorrent-nox", `f:${flaggedAt - 25 * MIN}:${flaggedAt}`],
    ]));
    r.data.set("vardo:anomaly:ports:a1", new Map([["tcp/8080", `f:${flaggedAt - 25 * MIN}:${flaggedAt}`]]));
    r.data.set("vardo:anomaly:procs:a2", new Map([
      ["postgres", `k:${start}`],
      ["xmrig", `f:${flaggedAt - 25 * MIN}:${flaggedAt}`],
    ]));
  });

  it("marks only sets with no known entries known and settles only their alerts", async () => {
    await pass(now);
    expect(entries("vardo:anomaly:procs:a1")).toEqual({ "s6-svscan": `k:${flaggedAt - 25 * MIN}`, "qbittorrent-nox": `k:${flaggedAt - 25 * MIN}` });
    expect(entries("vardo:anomaly:ports:a1")).toEqual({ "tcp/8080": `k:${flaggedAt - 25 * MIN}` });
    expect(entries("vardo:anomaly:procs:a2")).toEqual({ postgres: `k:${start}`, xmrig: `f:${flaggedAt - 25 * MIN}:${flaggedAt}` });
    expect(mocks.settle.mock.calls.map(([org, type, abouts]) => [org, type, abouts])).toEqual([
      ["o1", "app.new-process", ["a1"]],
      ["o1", "app.new-port", ["a1"]],
    ]);
  });

  it("runs once per Redis", async () => {
    await pass(now);
    r.data.set("vardo:anomaly:procs:a3", new Map([["sh", `f:${now}:${now}`]]));
    expect(await repairLostSeen(now + MIN, async () => {})).toEqual([]);
    expect(entries("vardo:anomaly:procs:a3")).toEqual({ sh: `f:${now}:${now}` });
  });
});
