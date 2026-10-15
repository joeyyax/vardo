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
      // Filled from WritableLayerSizes while Disk metrics are on.
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
  /** Writable-layer sizes from Docker, when Disk metrics are on. */
  sizes?: WritableLayerSizes;
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
    const ids = containers.map((c) => c.id);
    const dockerLabels = this.opts.dockerLabels ? await this.opts.dockerLabels(ids) : undefined;
    const metrics = mapCollectorContainers(containers, { timestamp, dockerLabels });
    const sizes = this.opts.sizes ? await this.opts.sizes.read(ids) : null;
    for (const m of metrics) {
      const size = sizes?.get(m.containerIdFull);
      if (size) {
        m.diskUsage = size.bytes;
        m.diskUsageAt = size.at;
      }
    }
    return metrics;
  }

  /** Time of the collector's last collection, ms. Throws when it's stale. The collector's `collected_at` replaces this. */
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
}

/**
 * Labels by container id, inspected once per container: they're fixed for its life, and a full list costs dockerd far more.
 * The collector's `containers.api_labels` replaces this join.
 */
export function dockerLabelSource(inspect: (id: string) => Promise<Record<string, string>>): LabelSource {
  const cache = new Map<string, Record<string, string>>();
  return async (ids) => {
    const live = new Set(ids);
    for (const id of cache.keys()) if (!live.has(id)) cache.delete(id);
    await Promise.all(
      ids.filter((id) => !cache.has(id)).map(async (id) => {
        try {
          cache.set(id, await inspect(id));
        } catch {
          // Gone or unreadable; the collector's own labels still apply. Tried again next poll.
        }
      }),
    );
    return cache;
  };
}

/** Each container's writable layer is measured at most this often. */
export const SIZE_PERIOD_MS = 60 * 60_000;

/**
 * Writable-layer sizes, one container at a time and spread across SIZE_PERIOD_MS: `size=1` makes dockerd walk the layer.
 * Nothing is requested while Disk metrics are off.
 */
export class WritableLayerSizes {
  private cache = new Map<string, { bytes: number; at: number }>();
  private lastRequestAt = -Infinity;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly inspectSize: (id: string) => Promise<number | null>,
    private readonly enabled: () => Promise<boolean>,
    private readonly opts: { periodMs?: number; now?: () => number } = {},
  ) {}

  /** Cached sizes for these containers; starts at most one background measurement. */
  async read(ids: string[]): Promise<Map<string, { bytes: number; at: number }>> {
    if (!(await this.enabled().catch(() => false))) {
      this.cache.clear();
      return this.cache;
    }
    const now = (this.opts.now ?? Date.now)();
    const period = this.opts.periodMs ?? SIZE_PERIOD_MS;
    const live = new Set(ids);
    for (const id of this.cache.keys()) if (!live.has(id)) this.cache.delete(id);

    const due = ids
      .filter((id) => now - (this.cache.get(id)?.at ?? -Infinity) >= period)
      .sort((a, b) => (this.cache.get(a)?.at ?? -Infinity) - (this.cache.get(b)?.at ?? -Infinity));
    if (!this.inFlight && due.length > 0 && now - this.lastRequestAt >= period / ids.length) {
      const id = due[0];
      this.lastRequestAt = now;
      this.inFlight = this.inspectSize(id)
        .then((bytes) => {
          if (bytes !== null) this.cache.set(id, { bytes, at: now });
        })
        .catch(() => {})
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.cache;
  }

  /** Settles the measurement in flight. For tests. */
  async settle(): Promise<void> {
    await this.inFlight;
  }
}
