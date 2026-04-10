import { fetchAllMetrics } from "./provider";
import type { ContainerMetrics } from "./types";
import { isMetricsEnabled } from "./config";
import { getGpuSnapshot } from "@/lib/gpu/collector";

// ---------------------------------------------------------------------------
// Shared cAdvisor broadcast — one poll serves all SSE subscribers
// ---------------------------------------------------------------------------

type Listener = {
  id: string;
  callback: (metrics: ContainerMetrics[]) => void;
};

let listeners: Listener[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;

const POLL_INTERVAL_MS = 5000;

/**
 * Subscribe to cAdvisor metrics updates.
 * The broadcast loop starts lazily on first subscriber and stops
 * when the last subscriber unsubscribes.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(
  callback: (metrics: ContainerMetrics[]) => void,
): () => void {
  const id = String(++nextId);
  listeners.push({ id, callback });

  // Start polling if this is the first subscriber
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

/** Latest metrics snapshot — available between polls for initial sends */
let latestMetrics: ContainerMetrics[] | null = null;

/**
 * Get the most recent metrics snapshot without waiting for the next poll.
 * Returns null if no data has been collected yet.
 */
export function getLatestSnapshot(): ContainerMetrics[] | null {
  return latestMetrics;
}

function startPolling() {
  if (timer) return;
  poll(); // immediate first poll
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

    // Merge cached GPU snapshot into cAdvisor metrics for live display.
    // The snapshot is updated by the metrics collector tick — no extra API calls here.
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

    // Dispatch to all listeners
    for (const listener of listeners) {
      try {
        listener.callback(metrics);
      } catch {
        // Don't let one bad listener break others
      }
    }
  } catch {
    // cAdvisor unavailable — skip this tick
  }

  if (listeners.length > 0) {
    timer = setTimeout(poll, POLL_INTERVAL_MS);
  }
}
