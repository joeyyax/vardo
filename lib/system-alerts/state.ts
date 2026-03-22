// ---------------------------------------------------------------------------
// Alert state tracking — prevents notification spam
// ---------------------------------------------------------------------------

export type AlertType =
  | "service-degraded"
  | "disk-space"
  | "host-restarted"
  | "cert-expiring"
  | "update-available";

type AlertState = {
  lastFired: Date;
  count: number;
};

// Rate limit windows in milliseconds per alert type
const RATE_LIMITS: Record<AlertType, number> = {
  "service-degraded": 15 * 60 * 1000, // 15 min
  "disk-space": 60 * 60 * 1000, // 1 hour
  "host-restarted": 365 * 24 * 60 * 60 * 1000, // effectively once per startup (reset on process restart)
  "cert-expiring": 24 * 60 * 60 * 1000, // 1 day
  "update-available": 24 * 60 * 60 * 1000, // 24 hours
};

const state = new Map<string, AlertState>();

function makeKey(type: AlertType, key: string): string {
  return `${type}:${key}`;
}

export function shouldFire(type: AlertType, key: string): boolean {
  const mapKey = makeKey(type, key);
  const entry = state.get(mapKey);
  if (!entry) return true;
  const elapsed = Date.now() - entry.lastFired.getTime();
  return elapsed >= RATE_LIMITS[type];
}

export function markFired(type: AlertType, key: string): void {
  const mapKey = makeKey(type, key);
  const existing = state.get(mapKey);
  state.set(mapKey, {
    lastFired: new Date(),
    count: (existing?.count ?? 0) + 1,
  });
}

export function getAlertState(): Array<{
  type: AlertType;
  key: string;
  lastFired: Date;
  count: number;
}> {
  return Array.from(state.entries()).map(([mapKey, entry]) => {
    const colonIdx = mapKey.indexOf(":");
    return {
      type: mapKey.slice(0, colonIdx) as AlertType,
      key: mapKey.slice(colonIdx + 1),
      lastFired: entry.lastFired,
      count: entry.count,
    };
  });
}

export function clearAlertState(type: AlertType, key: string): void {
  state.delete(makeKey(type, key));
}
