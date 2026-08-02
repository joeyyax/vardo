/**
 * Recovery clears the entry, so presence means the service is down now. This
 * only guards against a monitor that died mid-outage and left the entry behind;
 * a live outage re-alerts daily, so the window has to outlast that.
 */
export const SERVICE_DOWN_STALE_MS = 26 * 60 * 60 * 1000;

export const ALERT_STATE_KEY = "system_alert_state";

export type PersistedAlertEntry = { lastFired: string; count: number };

export type ServiceDown = { id: string; name: string; lastFired: string };

/** Services currently alerting, worst-case bounded by the staleness guard. */
export function selectActiveServiceAlerts(
  parsed: Record<string, PersistedAlertEntry> | null | undefined,
  now: Date,
): ServiceDown[] {
  const down: ServiceDown[] = [];
  for (const [key, entry] of Object.entries(parsed ?? {})) {
    const split = key.indexOf(":");
    if (split < 0 || key.slice(0, split) !== "service-degraded") continue;
    const name = key.slice(split + 1);
    if (!name) continue;
    const lastFired = new Date(entry?.lastFired ?? 0);
    if (Number.isNaN(lastFired.getTime())) continue;
    if (now.getTime() - lastFired.getTime() > SERVICE_DOWN_STALE_MS) continue;
    down.push({ id: key, name, lastFired: lastFired.toISOString() });
  }
  return down.sort((a, b) => a.name.localeCompare(b.name));
}
