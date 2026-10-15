// Container metrics from the collector's JSON API, in cAdvisor's ContainerMetrics shape.

import { CollectorHttpError, type CollectorClient, type CollectorContainer } from "@/lib/collector/client";
import { COLLECTOR_INTERVAL_MS } from "@/lib/collector/config";
import { identityLabels, organizationOf, projectOf } from "./cadvisor";
import type { MetricsProvider } from "./provider";
import type { ContainerMetrics } from "./types";

/** Swap on zram is memory, not disk writes. */
const NON_DISK_DEVICE = /^\/dev\/zram\d+$/;

/** A collection older than this is stale, as the collector's own /health judges it. */
export const STALE_AFTER_MS = COLLECTOR_INTERVAL_MS * 3 + 5000;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Maps the collector's containers onto ContainerMetrics.
 * `dockerLabels` fills labels outside the collector's allowlist (org, project id, host.*).
 * A container without a CPU rate yet (its first collection) is left out rather than shown at 0%.
 */
export function mapCollectorContainers(
  containers: CollectorContainer[],
  opts: { timestamp: number; dockerLabels?: Map<string, Record<string, string>> },
): ContainerMetrics[] {
  const out: ContainerMetrics[] = [];
  for (const c of containers) {
    const labels = { ...c.labels, ...opts.dockerLabels?.get(c.id) };
    const projectName = projectOf(labels);
    if (!projectName) continue;
    if (c.cpu.usage_cores === null) continue;

    const memoryUsage = c.memory.working_set_bytes || c.memory.usage_bytes;
    const memoryLimit = c.memory.limit_bytes ?? 0;

    let networkRxBytes = 0;
    let networkTxBytes = 0;
    for (const iface of c.network) {
      networkRxBytes += iface.receive_bytes_total;
      networkTxBytes += iface.transmit_bytes_total;
    }

    let diskWriteBytes = 0;
    for (const dev of c.io) {
      if (!NON_DISK_DEVICE.test(dev.device)) diskWriteBytes += dev.write_bytes_total;
    }

    out.push({
      containerId: c.id.slice(0, 12),
      containerIdFull: c.id,
      containerName: c.name,
      projectName,
      organizationId: organizationOf(labels),
      labels: identityLabels(labels),
      cpuPercent: round2(c.cpu.usage_cores * 100),
      memoryUsage,
      memoryLimit,
      memoryPercent: memoryLimit > 0 ? round2((memoryUsage / memoryLimit) * 100) : 0,
      networkRxBytes,
      networkTxBytes,
      // The collector skips the writable-layer walk; see CollectorMetricsProvider's disk source.
      diskUsage: null,
      diskLimit: null,
      diskWriteBytes,
      processCount: c.pids.current,
      // Filled from the GPU source in the collector tick.
      gpuUtilization: 0,
      gpuMemoryUsed: 0,
      gpuMemoryTotal: 0,
      gpuTemperature: 0,
      timestamp: opts.timestamp,
    });
  }
  return out;
}

type LabelSource = (ids: string[]) => Promise<Map<string, Record<string, string>>>;

type Options = {
  /** Docker labels by full container id. */
  dockerLabels?: LabelSource;
  /** Per-container filesystem bytes, read from cAdvisor when its disk metrics are on. */
  disk?: { enabled: () => Promise<boolean>; provider: MetricsProvider };
};

export class CollectorMetricsProvider implements MetricsProvider {
  readonly name: string;
  readonly pollIntervalMs = COLLECTOR_INTERVAL_MS;

  constructor(
    private readonly client: CollectorClient,
    private readonly opts: Options = {},
  ) {
    this.name = `collector at ${client.url}`;
  }

  async fetchAll(): Promise<ContainerMetrics[]> {
    const [containers, timestamp] = await Promise.all([this.client.containers(), this.collectedAt()]);
    if (containers.length > 0 && containers.every((c) => c.cpu.usage_cores === null)) {
      throw new Error("collector has no rates yet (first collection)");
    }
    const dockerLabels = this.opts.dockerLabels ? await this.opts.dockerLabels(containers.map((c) => c.id)) : undefined;
    const metrics = mapCollectorContainers(containers, { timestamp, dockerLabels });
    await this.fillDisk(metrics);
    return metrics;
  }

  /** Time of the collector's last collection, ms. Throws when it's stale. */
  private async collectedAt(): Promise<number> {
    let at: number;
    try {
      at = Math.round((await this.client.host()).timestamp * 1000);
    } catch (err) {
      // 503 means host metrics are off or not collected yet; /health still has the age.
      if (!(err instanceof CollectorHttpError && err.status === 503)) throw err;
      const health = await this.client.health();
      if (health.last_collect_age_seconds === null) throw new Error("collector has not collected yet");
      at = Math.round((Date.now() - health.last_collect_age_seconds * 1000) / 1000) * 1000;
    }
    const age = Date.now() - at;
    if (age > STALE_AFTER_MS) throw new Error(`collector is stale (last collection ${Math.round(age / 1000)}s ago)`);
    return at;
  }

  private async fillDisk(metrics: ContainerMetrics[]): Promise<void> {
    const disk = this.opts.disk;
    if (!disk || !(await disk.enabled().catch(() => false))) return;
    let rows: ContainerMetrics[];
    try {
      rows = await disk.provider.fetchAll();
    } catch {
      return; // Leaves disk unset, as cAdvisor with disk metrics off does.
    }
    const byId = new Map(rows.map((r) => [r.containerIdFull || r.containerId, r]));
    for (const m of metrics) {
      const row = byId.get(m.containerIdFull) ?? byId.get(m.containerId);
      if (row) {
        m.diskUsage = row.diskUsage;
        m.diskLimit = row.diskLimit;
      }
    }
  }
}

/** Labels from Docker's container list, refreshed every minute or when an id is missing. */
export function dockerLabelSource(
  list: () => Promise<{ id: string; labels: Record<string, string> }[]>,
  opts: { ttlMs?: number; minRefreshMs?: number; now?: () => number } = {},
): LabelSource {
  const ttl = opts.ttlMs ?? 60_000;
  const minRefresh = opts.minRefreshMs ?? 5_000;
  const now = opts.now ?? Date.now;
  let cache: { at: number; byId: Map<string, Record<string, string>> } | null = null;

  return async (ids) => {
    const stale = !cache || now() - cache.at > ttl;
    const missing = !!cache && ids.some((id) => !cache!.byId.has(id)) && now() - cache.at > minRefresh;
    if (stale || missing) {
      try {
        const rows = await list();
        cache = { at: now(), byId: new Map(rows.map((r) => [r.id, r.labels])) };
      } catch {
        // Keep the last list; the collector's own labels still apply.
      }
    }
    return cache?.byId ?? new Map();
  };
}
