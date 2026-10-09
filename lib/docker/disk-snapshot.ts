import {
  attributeDiskToProjects,
  getDfVolumes,
  getDfWithoutVolumes,
  summarizeDiskUsage,
  type DfVolumes,
  type DiskUsage,
} from "./client";

/** Volume sizes cost dockerd a per-volume walk (13-24 s on 460 volumes), so they refresh hourly. */
export const VOLUME_REFRESH_MS = 60 * 60_000;

let volumes: { at: number; data: DfVolumes } | null = null;
let volumesInFlight: Promise<DfVolumes> | null = null;

async function currentVolumes(now: number): Promise<DfVolumes> {
  if (volumes && now - volumes.at < VOLUME_REFRESH_MS) return volumes.data;
  volumesInFlight ??= getDfVolumes()
    .then((data) => {
      volumes = { at: now, data };
      return data;
    })
    .finally(() => {
      volumesInFlight = null;
    });
  try {
    return await volumesInFlight;
  } catch (err) {
    // Serve the last good sizes rather than drop the series.
    if (volumes) return volumes.data;
    throw err;
  }
}

/** One cheap `/system/df` per call; volume sizes come from the hourly cache. */
export async function getDiskSnapshot(now = Date.now()): Promise<{
  usage: DiskUsage;
  perProject: Map<string, number>;
}> {
  const [rest, vols] = await Promise.all([getDfWithoutVolumes(), currentVolumes(now)]);
  return {
    usage: summarizeDiskUsage({ ...rest, ...vols }),
    perProject: attributeDiskToProjects({ ...rest, ...vols }),
  };
}

export function resetDiskSnapshotCache() {
  volumes = null;
  volumesInFlight = null;
}
