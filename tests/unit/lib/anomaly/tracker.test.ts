import { describe, expect, it } from "vitest";
import { AppRateTracker } from "@/lib/anomaly/tracker";
import type { ContainerMetrics } from "@/lib/metrics/types";

function container(id: string, at: number, counters: { rx: number; tx: number; write?: number | null; cpu?: number; pids?: number | null }): ContainerMetrics {
  return {
    containerId: id,
    containerIdFull: "",
    containerName: id,
    projectName: "shop",
    organizationId: "org1",
    labels: {},
    cpuPercent: counters.cpu ?? 1,
    memoryUsage: 0,
    memoryLimit: 0,
    memoryPercent: 0,
    networkRxBytes: counters.rx,
    networkTxBytes: counters.tx,
    diskUsage: null,
    diskLimit: null,
    diskWriteBytes: counters.write ?? null,
    processCount: counters.pids,
    gpuUtilization: 0,
    gpuMemoryUsed: 0,
    gpuMemoryTotal: 0,
    gpuTemperature: 0,
    timestamp: at,
  };
}

describe("AppRateTracker", () => {
  it("has gauges at once and rates from the second snapshot", () => {
    const t = new AppRateTracker();
    const first = t.observe("a1", [container("c1", 0, { rx: 0, tx: 0, cpu: 4, pids: 3 })]);
    expect(first.values).toEqual({ cpu: 4, pids: 3 });
    const second = t.observe("a1", [container("c1", 30_000, { rx: 3_000, tx: 60_000, write: null, cpu: 5, pids: 3 })]);
    expect(second.values).toMatchObject({ cpu: 5, egress: 2_000, ingress: 100 });
    expect(second.values.diskWrite).toBeUndefined();
    expect(second.restarted).toBe(false);
  });

  it("sums an app's containers", () => {
    const t = new AppRateTracker();
    t.observe("a1", [container("c1", 0, { rx: 0, tx: 0 }), container("c2", 0, { rx: 0, tx: 0 })]);
    const r = t.observe("a1", [container("c1", 10_000, { rx: 0, tx: 1_000 }), container("c2", 10_000, { rx: 0, tx: 4_000 })]);
    expect(r.values.egress).toBe(500);
    expect(r.values.cpu).toBe(2);
  });

  it("reports a counter going backwards as a restart, with no rate", () => {
    const t = new AppRateTracker();
    t.observe("a1", [container("c1", 0, { rx: 500, tx: 500 })]);
    const r = t.observe("a1", [container("c1", 10_000, { rx: 10, tx: 10 })]);
    expect(r.restarted).toBe(true);
    expect(r.values.egress).toBeUndefined();
  });

  it("reports a changed container set as a restart", () => {
    const t = new AppRateTracker();
    t.observe("a1", [container("blue", 0, { rx: 0, tx: 0 })]);
    const r = t.observe("a1", [container("green", 10_000, { rx: 0, tx: 0 })]);
    expect(r.restarted).toBe(true);
    expect(r.values.egress).toBeUndefined();
  });

  it("leaves out the process count when cAdvisor doesn't report it", () => {
    const r = new AppRateTracker().observe("a1", [container("c1", 0, { rx: 0, tx: 0, pids: null })]);
    expect(r.values.pids).toBeUndefined();
  });
});
