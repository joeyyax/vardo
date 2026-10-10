import { describe, expect, it } from "vitest";
import { isPresent, summarizeWorkers } from "@/lib/worker/presence";

const now = new Date("2026-10-10T12:00:00Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);
const row = (beatAgoS: number, extra: { ready?: boolean; draining?: boolean } = {}) => ({
  heartbeatAt: ago(beatAgoS),
  readyAt: extra.ready === false ? null : ago(600),
  drainingAt: extra.draining ? ago(5) : null,
});

describe("worker presence", () => {
  it("counts a ready worker that beat inside 90s", () => {
    expect(isPresent(row(10), now)).toBe(true);
    expect(isPresent(row(89), now)).toBe(true);
    expect(isPresent(row(91), now)).toBe(false);
  });

  it("doesn't count a booting or draining worker", () => {
    expect(isPresent(row(5, { ready: false }), now)).toBe(false);
    expect(isPresent(row(5, { draining: true }), now)).toBe(false);
  });

  it("summarizes the newest beat and whether any worker is present", () => {
    expect(summarizeWorkers([], now)).toEqual({ workerAt: null, workerReady: false });
    expect(summarizeWorkers([row(300), row(20, { draining: true })], now)).toEqual({ workerAt: ago(20), workerReady: false });
    expect(summarizeWorkers([row(300), row(20)], now)).toEqual({ workerAt: ago(20), workerReady: true });
  });
});
