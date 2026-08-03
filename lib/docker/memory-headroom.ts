// ---------------------------------------------------------------------------
// Whether both slots fit in memory at once
//
// A blue-green cutover holds two copies of an app's memory for the overlap
// window. When the host has no room for the second, the kernel picks a victim
// from every container running without a limit — most of a fleet, not just the
// app being deployed.
// ---------------------------------------------------------------------------

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

/** Memory kept clear of the overlap so the kernel keeps its room to reclaim. */
export function overlapReserve(hostTotalBytes: number): number {
  return Math.max(MIN_OVERLAP_RESERVE, hostTotalBytes * OVERLAP_RESERVE_FRACTION);
}

/**
 * Whether both slots fit. An incomplete reading fits — a host with no metrics
 * must not have every deploy quietly change shape.
 */
export function overlapFits(reading: MemoryReading): OverlapVerdict {
  const { hostTotalBytes: total, fleetUsedBytes: used, appFootprintBytes: app } = reading;
  if (total === null || total <= 0 || used === null || app === null) {
    return { fits: true, headroomBytes: null, reserveBytes: null };
  }

  const reserve = overlapReserve(total);
  const headroom = total - used - app;
  return { fits: headroom >= reserve, headroomBytes: headroom, reserveBytes: reserve };
}

// ---------------------------------------------------------------------------
// Reading the host
// ---------------------------------------------------------------------------

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
    const { getFleetTotals } = await import("@/lib/metrics/fleet-totals");
    const totals = await getFleetTotals();
    return totals?.memoryBytes ?? null;
  } catch {
    return null;
  }
}

/**
 * The app's peak over the sparkline window, not its reading right now — a
 * sample taken in a trough underestimates what the second copy will hold.
 * A deploy inside the same window had both slots up and reads high, which
 * costs an overlap rather than risking one.
 */
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
  const [hostTotalBytes, fleetUsedBytes, appFootprintBytes] = await Promise.all([
    readHostTotal(),
    readFleetUsed(),
    readAppFootprint(organizationId, appId),
  ]);
  return { hostTotalBytes, fleetUsedBytes, appFootprintBytes };
}

/**
 * Whether this app's cutover can hold both slots, logged either way. Falls open
 * on anything it could not read.
 */
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
