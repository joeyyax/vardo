/**
 * A service-degraded entry is never cleared on recovery, so recency is the only
 * signal. A service that is still down re-fires every 15 minutes, so 20 tolerates
 * one late cycle without showing a recovered service as down for the best part
 * of an hour.
 */
export const SERVICE_DOWN_STALE_MS = 20 * 60 * 1000;

export const ALERT_STATE_KEY = "system_alert_state";

export type PersistedAlertEntry = { lastFired: string; count: number };

export type ServiceDown = { id: string; name: string; lastFired: string };

/**
 * The alert ledger exists to rate-limit notifications, so an entry survives the
 * recovery that should have cleared it. Recency is the only signal that a
 * service is still down.
 */
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
