// Whether both slots of a blue-green cutover fit in host memory at once.

const GIB = 1024 ** 3;

/** Floor on the reserve, whatever the host's size. */
export const MIN_OVERLAP_RESERVE = GIB;

/** Share of host memory held back for everything that is not this deploy. */
export const OVERLAP_RESERVE_FRACTION = 0.1;

export type MemoryReading = {
  /** Host RAM. Null when Docker's /info was unreachable. */
  hostTotalBytes: number | null;
  /** Summed container working sets across the fleet. Null when nothing collects them. */
  fleetUsedBytes: number | null;
  /** This app's observed footprint — the copy the overlap duplicates. */
  appFootprintBytes: number | null;
};

export type OverlapVerdict = {
  fits: boolean;
  /** Bytes left once the second copy is up. Null when the reading was incomplete. */
  headroomBytes: number | null;
  reserveBytes: number | null;
};

/** Memory kept clear of the overlap. */
export function overlapReserve(hostTotalBytes: number): number {
  return Math.max(MIN_OVERLAP_RESERVE, hostTotalBytes * OVERLAP_RESERVE_FRACTION);
}

/** Whether both slots fit. An incomplete reading fits. */
export function overlapFits(reading: MemoryReading): OverlapVerdict {
  const { hostTotalBytes: total, fleetUsedBytes: used, appFootprintBytes: app } = reading;
  if (total === null || total <= 0 || used === null || app === null) {
    return { fits: true, headroomBytes: null, reserveBytes: null };
  }

  const reserve = overlapReserve(total);
  const headroom = total - used - app;
  return { fits: headroom >= reserve, headroomBytes: headroom, reserveBytes: reserve };
}

/** How long a deploy waits on the metrics store before overlapping anyway. */
export const METRICS_READ_TIMEOUT_MS = 1000;

/** Null once the bound passes. */
async function bounded<T>(read: Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), METRICS_READ_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readHostTotal(): Promise<number | null> {
  try {
    const { getSystemInfo } = await import("./client");
    const info = await getSystemInfo();
    return info.memoryTotal > 0 ? info.memoryTotal : null;
  } catch {
    return null;
  }
}

async function readFleetUsed(): Promise<number | null> {
  try {
    const { isMetricsEnabled } = await import("@/lib/metrics/config");
    if (!isMetricsEnabled()) return null;
    const { getFleetTotals } = await import("@/lib/metrics/fleet-totals");
    const totals = await getFleetTotals();
    return totals?.memoryBytes ?? null;
  } catch {
    return null;
  }
}

/** The app's peak memory over the sparkline window. */
async function readAppFootprint(
  organizationId: string,
  appId: string,
): Promise<number | null> {
  try {
    const { getAppResources } = await import("@/lib/metrics/resources-query");
    const snapshot = await getAppResources(organizationId, appId);
    if (!snapshot) return null;

    const samples = snapshot.memory.series
      .map(([, value]) => value)
      .filter((v): v is number => v !== null);
    const peak = Math.max(...samples, snapshot.memory.usage ?? 0);
    return peak > 0 ? peak : null;
  } catch {
    return null;
  }
}

/** Host total, fleet usage and this app's footprint, each best-effort. */
export async function readMemory(
  organizationId: string,
  appId: string,
): Promise<MemoryReading> {
  const hostTotalBytes = await readHostTotal();
  if (hostTotalBytes === null) {
    return { hostTotalBytes, fleetUsedBytes: null, appFootprintBytes: null };
  }

  const [fleetUsedBytes, appFootprintBytes] = await Promise.all([
    bounded(readFleetUsed()),
    bounded(readAppFootprint(organizationId, appId)),
  ]);
  return { hostTotalBytes, fleetUsedBytes, appFootprintBytes };
}

/** Whether this app's cutover can hold both slots, logged either way. Falls open on unreadable metrics. */
export async function overlapFitsNow(
  organizationId: string,
  appId: string,
  log: (line: string) => void,
): Promise<boolean> {
  const verdict = overlapFits(await readMemory(organizationId, appId));
  if (verdict.headroomBytes === null || verdict.reserveBytes === null) return true;

  const { formatBytes } = await import("@/lib/metrics/format");
  if (verdict.fits) {
    log(`[deploy] Both slots fit — ${formatBytes(verdict.headroomBytes)} would be left on the host`);
    return true;
  }

  log(
    `[deploy] Not enough memory to run both slots — ${formatBytes(verdict.headroomBytes)} would be left, below the ${formatBytes(verdict.reserveBytes)} reserve. Stopping the old slot first instead of overlapping.`,
  );
  return false;
}
