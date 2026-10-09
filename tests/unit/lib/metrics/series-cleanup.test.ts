import { describe, it, expect, vi, beforeEach } from "vitest";

const { state, callMock, dbMock } = vi.hoisted(() => {
  const state = {
    keys: new Set<string>(),
    lastSample: {} as Record<string, number>,
    ttls: {} as Record<string, number>,
    apps: [] as { id: string; name: string }[],
  };

  function globToRegExp(glob: string): RegExp {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === "\\") re += "\\" + glob[++i];
      else if (c === "*") re += ".*";
      else re += c.replace(/[.+^${}()|[\]]/g, "\\$&");
    }
    return new RegExp(`^${re}$`);
  }

  const callMock = vi.fn(async (cmd: string, ...args: string[]) => {
    if (cmd === "SCAN") {
      const re = globToRegExp(args[2]);
      return ["0", [...state.keys].filter((k) => re.test(k))];
    }
    if (cmd === "UNLINK") {
      let n = 0;
      for (const k of args) if (state.keys.delete(k)) n++;
      return n;
    }
    if (cmd === "PTTL") return state.keys.has(args[0]) ? (state.ttls[args[0]] ?? -1) : -2;
    if (cmd === "PEXPIRE") {
      state.ttls[args[0]] = Number(args[1]);
      return 1;
    }
    if (cmd === "TS.GET") {
      const ts = state.lastSample[args[0]];
      return ts === undefined ? null : [String(ts), "1"];
    }
    throw new Error(`unexpected ${cmd}`);
  });

  const dbMock = { select: vi.fn(() => ({ from: async () => state.apps })) };
  return { state, callMock, dbMock };
});

vi.mock("@/lib/metrics/ts-client", () => ({
  tsRedis: { call: callMock },
  forgetKey: vi.fn(),
  RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
}));
vi.mock("@/lib/db", () => ({ db: dbMock }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { RETENTION_MS } from "@/lib/metrics/ts-client";
import { deleteAppSeries, parseSeriesKey, sweepOrphanSeries } from "@/lib/metrics/series-cleanup";

const OLD = Date.now() - 3 * 60 * 60_000;
const FRESH = Date.now() - 60_000;

function seed(keys: string[], sampledAt = OLD) {
  for (const k of keys) {
    state.keys.add(k);
    state.lastSample[k] = sampledAt;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  state.keys.clear();
  state.lastSample = {};
  state.ttls = {};
  state.apps = [];
});

describe("parseSeriesKey", () => {
  it("reads container, disk and log series", () => {
    expect(parseSeriesKey("metrics:agents:cpu:abc123")).toEqual({ kind: "project", project: "agents" });
    expect(parseSeriesKey("metrics:agents:disk")).toEqual({ kind: "project", project: "agents" });
    expect(parseSeriesKey("metrics:logs:app1:errors")).toEqual({ kind: "logs", appId: "app1" });
  });

  it("keeps a colon inside the project name", () => {
    expect(parseSeriesKey("metrics:a:b:memory:c1")).toEqual({ kind: "project", project: "a:b" });
  });

  it("ignores reserved namespaces and unknown shapes", () => {
    expect(parseSeriesKey("metrics:system:diskTotal")).toBeNull();
    expect(parseSeriesKey("metrics:business:org1:revenue")).toBeNull();
    expect(parseSeriesKey("metrics:agents:unknown:abc")).toBeNull();
    expect(parseSeriesKey("other:agents:cpu:abc")).toBeNull();
  });
});

describe("deleteAppSeries", () => {
  it("deletes only the project's own series, not a longer name sharing its prefix", async () => {
    seed([
      "metrics:glitchtip:cpu:c1",
      "metrics:glitchtip:memory:c1",
      "metrics:glitchtip:disk",
      "metrics:glitchtip-production-green:cpu:c2",
      "metrics:glitchtip-production-green:disk",
      "metrics:glitchtip:cpu:x:cpu:c3",
    ]);

    const removed = await deleteAppSeries({ projects: ["glitchtip"], appIds: [] });

    expect(removed).toBe(3);
    expect([...state.keys].sort()).toEqual([
      "metrics:glitchtip-production-green:cpu:c2",
      "metrics:glitchtip-production-green:disk",
      "metrics:glitchtip:cpu:x:cpu:c3",
    ]);
  });

  it("uses SCAN with a pattern and never KEYS", async () => {
    seed(["metrics:agents:cpu:c1"]);
    await deleteAppSeries({ projects: ["agents"], appIds: ["app1"] });
    const cmds = callMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("SCAN");
    expect(cmds).not.toContain("KEYS");
    expect(callMock.mock.calls.find((c) => c[0] === "SCAN")?.[3]).toBe("metrics:agents:*");
  });

  it("deletes the app's log series by id", async () => {
    seed(["metrics:logs:app1:errors", "metrics:logs:app1:lines", "metrics:logs:app2:errors"]);
    await deleteAppSeries({ projects: [], appIds: ["app1"] });
    expect([...state.keys]).toEqual(["metrics:logs:app2:errors"]);
  });

  it("escapes glob characters in the project name", async () => {
    seed(["metrics:a*:cpu:c1", "metrics:abc:cpu:c1"]);
    await deleteAppSeries({ projects: ["a*"], appIds: [] });
    expect([...state.keys]).toEqual(["metrics:abc:cpu:c1"]);
  });
});

describe("sweepOrphanSeries", () => {
  it("deletes quiet series of apps that no longer exist and keeps the rest", async () => {
    state.apps = [
      { id: "a1", name: "glitchtip" },
      { id: "a2", name: "glitchtip-production-green" },
    ];
    seed(["metrics:agents:cpu:c1", "metrics:agents:cpu:c2", "metrics:agents:disk"]);
    seed(["metrics:glitchtip:cpu:c3", "metrics:glitchtip-production-green:cpu:c4"]);
    seed(["metrics:logs:gone:errors", "metrics:logs:a1:errors"]);
    seed(["metrics:system:diskTotal", "metrics:business:org1:revenue"]);

    const removed = await sweepOrphanSeries();

    expect(removed).toBe(4);
    expect([...state.keys].sort()).toEqual([
      "metrics:business:org1:revenue",
      "metrics:glitchtip-production-green:cpu:c4",
      "metrics:glitchtip:cpu:c3",
      "metrics:logs:a1:errors",
      "metrics:system:diskTotal",
    ]);
  });

  it("does not match one app's name against another's prefix", async () => {
    state.apps = [{ id: "a2", name: "glitchtip-production-green" }];
    seed(["metrics:glitchtip:cpu:c1", "metrics:glitchtip-production-green:cpu:c2"]);

    await sweepOrphanSeries();

    expect([...state.keys]).toEqual(["metrics:glitchtip-production-green:cpu:c2"]);
  });

  it("keeps series that still receive samples, such as a non-app container", async () => {
    seed(["metrics:vardo-console:cpu:c1"], FRESH);
    expect(await sweepOrphanSeries()).toBe(0);
    expect(state.keys.size).toBe(1);
  });

  it("uses SCAN and never KEYS", async () => {
    await sweepOrphanSeries();
    const cmds = callMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("SCAN");
    expect(cmds).not.toContain("KEYS");
  });
});

describe("sweepOrphanSeries TTL backfill", () => {
  it("expires live-app series that have no TTL and leaves ones that have one", async () => {
    state.apps = [{ id: "a1", name: "vardo" }];
    seed(["metrics:vardo:memoryLimit:docker-cf61a", "metrics:vardo:cpu:c2", "metrics:logs:a1:errors"]);
    state.ttls["metrics:vardo:cpu:c2"] = 1000;

    await sweepOrphanSeries();

    expect(state.ttls["metrics:vardo:memoryLimit:docker-cf61a"]).toBe(RETENTION_MS);
    expect(state.ttls["metrics:logs:a1:errors"]).toBe(RETENTION_MS);
    expect(state.ttls["metrics:vardo:cpu:c2"]).toBe(1000);
  });

  it("skips system, business and disk series, which are written without a TTL", async () => {
    state.apps = [{ id: "a1", name: "vardo" }];
    seed(["metrics:system:diskTotal", "metrics:business:org1:revenue", "metrics:vardo:disk"]);

    await sweepOrphanSeries();

    expect(state.ttls).toEqual({});
  });
});
