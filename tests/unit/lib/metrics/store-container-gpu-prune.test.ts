import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// pruneStaleGpuSeries: a genuinely stale GPU reading gets deleted, a fresh
// one is left alone.
// ---------------------------------------------------------------------------

const state = vi.hoisted(() => ({
  calls: [] as unknown[][],
  tsGetByKey: new Map<string, [string, string] | null>(),
  forgotten: [] as string[],
  RETENTION_MS: 7 * 24 * 60 * 60 * 1000,
}));

vi.mock("@/lib/metrics/ts-client", () => ({
  tsRedis: {
    call: async (...args: unknown[]) => {
      state.calls.push(args);
      const [cmd] = args;
      if (cmd === "SCAN") {
        return ["0", [...state.tsGetByKey.keys()]];
      }
      if (cmd === "TS.GET") {
        const key = args[1] as string;
        return state.tsGetByKey.get(key) ?? null;
      }
      if (cmd === "DEL") return 1;
      return "OK";
    },
  },
  tsKey: (project: string, metric: string, container?: string) =>
    container ? `metrics:${project}:${metric}:${container}` : `metrics:${project}:${metric}`,
  ensureTimeSeries: vi.fn(),
  touchRetention: vi.fn(),
  forgetKey: (key: string) => state.forgotten.push(key),
  RETENTION_MS: state.RETENTION_MS,
}));

import { pruneStaleGpuSeries } from "@/lib/metrics/store-container";

describe("pruneStaleGpuSeries", () => {
  beforeEach(() => {
    state.calls.length = 0;
    state.tsGetByKey.clear();
    state.forgotten.length = 0;
  });

  it("prunes a series whose last sample is far older than retention (e.g. 114 days)", async () => {
    const now = Date.now();
    const staleTs = now - 114 * 24 * 60 * 60 * 1000;
    state.tsGetByKey.set("metrics:plex:gpuUtilization:c1", [staleTs.toString(), "42"]);

    const pruned = await pruneStaleGpuSeries();

    expect(pruned).toBe(1);
    const deleted = state.calls.filter((c) => c[0] === "DEL").map((c) => c[1]);
    expect(deleted).toEqual(
      expect.arrayContaining([
        "metrics:plex:gpuUtilization:c1",
        "metrics:plex:gpuMemoryUsed:c1",
        "metrics:plex:gpuMemoryTotal:c1",
        "metrics:plex:gpuTemperature:c1",
      ]),
    );
    expect(state.forgotten).toEqual(expect.arrayContaining(deleted));
  });

  it("leaves a fresh series alone", async () => {
    const now = Date.now();
    state.tsGetByKey.set("metrics:scrypted:gpuUtilization:c2", [(now - 5_000).toString(), "10"]);

    const pruned = await pruneStaleGpuSeries();

    expect(pruned).toBe(0);
    expect(state.calls.some((c) => c[0] === "DEL")).toBe(false);
  });

  it("prunes a reading exactly at the retention boundary", async () => {
    const now = Date.now();
    const staleTs = now - (state.RETENTION_MS + 1);
    state.tsGetByKey.set("metrics:old:gpuUtilization:c3", [staleTs.toString(), "99"]);

    await pruneStaleGpuSeries();

    expect(state.calls).toContainEqual(["DEL", "metrics:old:gpuUtilization:c3"]);
  });
});
