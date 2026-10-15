import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  flags: new Map<string, string>(),
  series: new Map<string, { at: number; value: number }[]>(),
}));

vi.mock("@/lib/redis", () => ({
  redis: {
    get: async (k: string) => h.flags.get(k) ?? null,
    set: async (k: string, v: string) => void h.flags.set(k, v),
  },
}));
vi.mock("@/lib/metrics/ts-client", () => ({
  tsRedis: {
    call: async (cmd: string, ...args: string[]) => {
      if (cmd === "TS.QUERYINDEX") {
        const signal = args.find((a) => a.startsWith("signal="))!.slice(7);
        return [...h.series.keys()].filter((k) => k.endsWith(`:${signal}`));
      }
      if (cmd === "TS.DEL") {
        const [key, from, to] = args;
        h.series.set(key, h.series.get(key)!.filter((s) => s.at < Number(from) || s.at > Number(to)));
        return 1;
      }
      throw new Error(`unexpected ${cmd}`);
    },
  },
}));

const { resetPidsSamples } = await import("@/lib/anomaly/store");

const samples = () => [{ at: 100, value: 5 }, { at: 300, value: 40 }];

beforeEach(() => {
  h.flags.clear();
  h.series.clear();
  h.series.set("anomaly:a1:pids", samples());
  h.series.set("anomaly:a1:cpu", samples());
  h.series.set("anomaly:a1:egress", samples());
});

describe("resetPidsSamples", () => {
  it("drops pids samples from the cutoff and leaves every other signal alone", async () => {
    await resetPidsSamples(200, 400);
    expect(h.series.get("anomaly:a1:pids")).toEqual([{ at: 100, value: 5 }]);
    expect(h.series.get("anomaly:a1:cpu")).toEqual(samples());
    expect(h.series.get("anomaly:a1:egress")).toEqual(samples());
  });

  it("runs once: later samples survive a second call", async () => {
    await resetPidsSamples(200, 400);
    h.series.get("anomaly:a1:pids")!.push({ at: 500, value: 6 });
    await resetPidsSamples(200, 600);
    expect(h.series.get("anomaly:a1:pids")).toEqual([{ at: 100, value: 5 }, { at: 500, value: 6 }]);
  });
});
