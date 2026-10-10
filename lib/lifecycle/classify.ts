// Pure lifecycle logic: boot classification, update markers and missing containers.

/** A Vardo-managed container that was running at heartbeat time. */
export type SnapshotContainer = { id: string; name: string; app?: string };

/** Written every 30 s while the console runs. Times are epoch ms. */
export type Heartbeat = {
  at: number;
  /** Host boot time, from /proc/stat btime. */
  hostBootAt: number | null;
  version: string;
  containers?: SnapshotContainer[];
};

/** Written on SIGTERM. Its absence on boot means the last stop was unclean. */
export type ShutdownMarker = { at: number; reason: string; version: string };

export type BootClassification =
  | { kind: "first-boot" }
  | { kind: "clean"; downSeconds: number; hostRebooted: boolean; reason: string }
  | { kind: "unclean"; downSeconds: number | undefined; hostRebooted: boolean; lastHeartbeatAt: string | undefined };

/** btime is whole seconds; os.uptime() fallbacks drift a little. */
const HOST_BOOT_TOLERANCE_MS = 60_000;

/** A marker older than the last heartbeat by more than this belongs to an earlier run. */
const MARKER_SLACK_MS = 5_000;

export function hostRebootedSince(previous: number | null | undefined, current: number | null): boolean {
  if (!previous || !current) return false;
  return Math.abs(current - previous) > HOST_BOOT_TOLERANCE_MS;
}

/** Clean restart, unclean stop or first boot, from what the last run left behind. */
export function classifyBoot(input: {
  heartbeat: Heartbeat | null;
  shutdown: ShutdownMarker | null;
  hostBootAt: number | null;
  /** When this process started. */
  startedAt: number;
}): BootClassification {
  const { heartbeat, shutdown, hostBootAt, startedAt } = input;
  if (!heartbeat && !shutdown) return { kind: "first-boot" };

  const hostRebooted = hostRebootedSince(heartbeat?.hostBootAt, hostBootAt);
  const seconds = (from: number) => Math.max(0, Math.round((startedAt - from) / 1000));

  const markerIsCurrent = shutdown !== null && (!heartbeat || shutdown.at >= heartbeat.at - MARKER_SLACK_MS);
  if (shutdown && markerIsCurrent) {
    return { kind: "clean", downSeconds: seconds(shutdown.at), hostRebooted, reason: shutdown.reason };
  }

  return {
    kind: "unclean",
    downSeconds: heartbeat ? seconds(heartbeat.at) : undefined,
    hostRebooted,
    lastHeartbeatAt: heartbeat ? new Date(heartbeat.at).toISOString() : undefined,
  };
}

/** Host boot time from /proc/stat. */
export function parseBtime(procStat: string): number | null {
  const match = procStat.match(/^btime\s+(\d+)$/m);
  return match ? Number(match[1]) * 1000 : null;
}

// `vardo update` writes $VARDO_HOME_DIR/lifecycle/update.json as it goes.

export type UpdateMarker = {
  id: string;
  state: "started" | "updated" | "failed";
  startedAt: number;
  finishedAt?: number;
  fromVersion: string;
  toVersion?: string;
  branch?: string;
  fromSlot?: string;
  toSlot?: string;
  step?: string;
  error?: string;
  rolledBack?: boolean;
  /** When the old console stopped and the new one answered. */
  swapStartedAt?: number;
  healthyAt?: number;
  logTail?: string[];
};

/** Markers older than this are history, not news. */
export const UPDATE_MARKER_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const STATES = new Set(["started", "updated", "failed"]);

/** install.sh writes epoch seconds; everything here is ms. */
function ms(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseUpdateMarker(text: string): UpdateMarker | null {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    const id = str(raw.id);
    const state = str(raw.state);
    const startedAt = ms(raw.startedAt);
    if (!id || !state || !STATES.has(state) || startedAt === undefined) return null;
    return {
      id,
      state: state as UpdateMarker["state"],
      startedAt,
      finishedAt: ms(raw.finishedAt),
      fromVersion: str(raw.fromVersion) ?? "unknown",
      toVersion: str(raw.toVersion),
      branch: str(raw.branch),
      fromSlot: str(raw.fromSlot),
      toSlot: str(raw.toSlot),
      step: str(raw.step),
      error: str(raw.error),
      rolledBack: raw.rolledBack === true,
      swapStartedAt: ms(raw.swapStartedAt),
      healthyAt: ms(raw.healthyAt),
      logTail: Array.isArray(raw.logTail) ? raw.logTail.filter((l): l is string => typeof l === "string").slice(-20) : undefined,
    };
  } catch {
    return null;
  }
}

/** A marker still "started" after this is an update that died, not one in flight. */
export const UPDATE_IN_FLIGHT_MS = 30 * 60_000;

export function updateInFlight(marker: UpdateMarker | null, now: number): marker is UpdateMarker {
  return marker?.state === "started" && now - marker.startedAt < UPDATE_IN_FLIGHT_MS;
}

/** States of one update run already announced. */
export type UpdateSeen = { id: string; states: UpdateMarker["state"][] };

/** What to announce for a marker, or null. Grouped: a finished update never also announces its start. */
export function updateAnnouncement(
  marker: UpdateMarker | null,
  seen: UpdateSeen | null,
  now: number,
): UpdateMarker["state"] | null {
  if (!marker) return null;
  if (now - (marker.finishedAt ?? marker.startedAt) > UPDATE_MARKER_MAX_AGE_MS) return null;
  const announced = seen?.id === marker.id ? seen.states : [];
  if (announced.includes(marker.state)) return null;
  if (marker.state === "started" && announced.length > 0) return null;
  return marker.state;
}

export function markSeen(seen: UpdateSeen | null, marker: UpdateMarker, state: UpdateMarker["state"]): UpdateSeen {
  const states = seen?.id === marker.id ? seen.states : [];
  return { id: marker.id, states: [...new Set([...states, state])] };
}

export function seconds(fromMs: number | undefined, toMs: number | undefined): number | undefined {
  return fromMs !== undefined && toMs !== undefined && toMs >= fromMs ? Math.round((toMs - fromMs) / 1000) : undefined;
}

/** Current state of a snapshot container, from a full container listing. */
export type ContainerNow = { id: string; state: string; restartPolicy?: string };

/** Containers running before the restart that aren't now. Removed ones and restart=no (retired slots) are left out. */
export function missingContainers(before: SnapshotContainer[], now: ContainerNow[]): (SnapshotContainer & { state: string })[] {
  const byId = new Map(now.map((c) => [c.id, c]));
  const missing: (SnapshotContainer & { state: string })[] = [];
  for (const c of before) {
    const current = byId.get(c.id);
    if (!current || current.state === "running") continue;
    if (current.restartPolicy === "no") continue;
    missing.push({ ...c, state: current.state });
  }
  return missing;
}
