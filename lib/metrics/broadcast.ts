import { fetchAllMetrics } from "./provider";
import type { ContainerMetrics } from "./types";
import { isMetricsEnabled } from "./config";
import { getGpuSnapshot } from "@/lib/gpu/collector";

// Shared cAdvisor broadcast: one poll serves all SSE subscribers.

type Listener = {
  id: string;
  callback: (metrics: ContainerMetrics[]) => void;
};

let listeners: Listener[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;

const POLL_INTERVAL_MS = 5000;

/** Subscribes to cAdvisor updates. Polling runs while anyone is subscribed. Returns an unsubscribe function. */
export function subscribe(
  callback: (metrics: ContainerMetrics[]) => void,
): () => void {
  const id = String(++nextId);
  listeners.push({ id, callback });

  if (listeners.length === 1) {
    startPolling();
  }

  return () => {
    listeners = listeners.filter((l) => l.id !== id);
    if (listeners.length === 0) {
      stopPolling();
    }
  };
}

/** Latest metrics snapshot, available between polls. */
let latestMetrics: ContainerMetrics[] | null = null;

/** Most recent metrics snapshot, or null before the first collection. */
export function getLatestSnapshot(): ContainerMetrics[] | null {
  return latestMetrics;
}

/** Publishes a snapshot fetched by the collector tick, so it's set with no stream open. */
export function setLatestSnapshot(metrics: ContainerMetrics[]): void {
  latestMetrics = metrics;
}

function startPolling() {
  if (timer) return;
  poll();
}

function stopPolling() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function poll() {
  if (listeners.length === 0) return;
  if (!isMetricsEnabled()) return;

  try {
    const metrics = await fetchAllMetrics();

    // Merge the cached GPU snapshot from the collector tick.
    const gpuSnapshot = getGpuSnapshot();
    if (gpuSnapshot.length > 0) {
      const containersWithGpu = new Set(
        metrics.filter((m) => m.gpuMemoryTotal > 0).map((m) => m.containerId),
      );
      for (const gm of gpuSnapshot) {
        if (containersWithGpu.has(gm.containerId)) continue;
        const match = metrics.find((m) => m.containerId === gm.containerId);
        if (match) {
          match.gpuUtilization = gm.gpuUtilization;
          match.gpuMemoryUsed = gm.gpuMemoryUsed;
          match.gpuMemoryTotal = gm.gpuMemoryTotal;
          match.gpuTemperature = gm.gpuTemperature;
        }
      }
    }

    latestMetrics = metrics;

    for (const listener of listeners) {
      try {
        listener.callback(metrics);
      } catch {
        // Don't let one bad listener break others.
      }
    }
  } catch {
    // cAdvisor unavailable; skip this tick.
  }

  if (listeners.length > 0) {
    timer = setTimeout(poll, POLL_INTERVAL_MS);
  }
}
