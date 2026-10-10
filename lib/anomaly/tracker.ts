// Per-app signal values from cAdvisor snapshots: summed gauges and per-container counter rates.

import type { ContainerMetrics } from "@/lib/metrics/types";
import type { SignalKey } from "./signals";

type Counters = { at: number; rx: number; tx: number; write: number | null };

export type AppReading = {
  values: Partial<Record<SignalKey, number>>;
  /** A counter went backwards or the container set changed: a restart or redeploy. */
  restarted: boolean;
};

const containerKey = (m: ContainerMetrics) => m.containerIdFull || m.containerId;

function rate(curr: number, prev: number, dtSec: number): number | null {
  if (dtSec <= 0 || curr < prev) return null;
  return (curr - prev) / dtSec;
}

/** Remembers each container's last counters to turn them into rates. */
export class AppRateTracker {
  private counters = new Map<string, Counters>();
  private containers = new Map<string, Set<string>>();

  observe(appId: string, metrics: ContainerMetrics[]): AppReading {
    const ids = new Set(metrics.map(containerKey));
    const known = this.containers.get(appId);
    const changed = !!known && (known.size !== ids.size || [...ids].some((id) => !known.has(id)));
    this.containers.set(appId, ids);

    const values: Partial<Record<SignalKey, number>> = {};
    if (metrics.length === 0) return { values, restarted: changed };

    values.cpu = metrics.reduce((sum, m) => sum + m.cpuPercent, 0);
    const pids = metrics.map((m) => m.processCount);
    if (pids.every((n) => typeof n === "number")) values.pids = (pids as number[]).reduce((a, b) => a + b, 0);

    let reset = false;
    let egress: number | null = 0;
    let ingress: number | null = 0;
    let diskWrite: number | null = 0;
    for (const m of metrics) {
      const key = containerKey(m);
      const prev = this.counters.get(key);
      const curr: Counters = { at: m.timestamp, rx: m.networkRxBytes, tx: m.networkTxBytes, write: m.diskWriteBytes };
      if (prev && curr.at === prev.at) {
        // The same snapshot twice: no new interval.
        egress = ingress = diskWrite = null;
        continue;
      }
      this.counters.set(key, curr);
      if (!prev) {
        egress = ingress = diskWrite = null;
        continue;
      }
      const dt = (curr.at - prev.at) / 1000;
      const tx = rate(curr.tx, prev.tx, dt);
      const rx = rate(curr.rx, prev.rx, dt);
      const write = curr.write !== null && prev.write !== null ? rate(curr.write, prev.write, dt) : null;
      if (curr.tx < prev.tx || curr.rx < prev.rx || (curr.write !== null && prev.write !== null && curr.write < prev.write)) reset = true;
      egress = egress === null || tx === null ? null : egress + tx;
      ingress = ingress === null || rx === null ? null : ingress + rx;
      diskWrite = diskWrite === null || write === null ? null : diskWrite + write;
    }
    if (egress !== null) values.egress = egress;
    if (ingress !== null) values.ingress = ingress;
    if (diskWrite !== null) values.diskWrite = diskWrite;
    return { values, restarted: changed || reset };
  }

  /** Drops counters for containers no longer reported. */
  prune(live: Iterable<ContainerMetrics>): void {
    const keep = new Set([...live].map(containerKey));
    for (const key of this.counters.keys()) if (!keep.has(key)) this.counters.delete(key);
  }
}
