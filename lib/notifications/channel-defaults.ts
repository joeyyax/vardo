import type { BusEvent, BusEventType } from "@/lib/bus";

/** Default enabled state per channel type when a user has no preference row. */
export const CHANNEL_TYPE_DEFAULTS: Record<string, boolean> = {
  email: true,
  slack: false,
  webhook: false,
};

/** Events that always send, regardless of preferences. */
export const CRITICAL_EVENT_TYPES: ReadonlySet<BusEventType> = new Set([
  "deploy.failed",
  "security.file-exposed",
  "security.scan-findings",
  "system.service-down",
  "system.update-failed",
  "system.recovered-unclean",
  "system.containers-missing",
] as BusEventType[]);

/** Whether this event sends regardless of preferences. An alert with a critical item does. */
export function isCriticalEvent(event: BusEvent): boolean {
  if (CRITICAL_EVENT_TYPES.has(event.type)) return true;
  if (event.type === "alert.fired") return event.alerts.some((a) => a.severity === "critical");
  if (event.type === "backup.summary") return event.rows.some((r) => r.outcome === "failed");
  return false;
}

/** Retired event types a channel filter may still name, by the type that replaced them. */
export const REPLACED_EVENT_TYPES: Partial<Record<BusEventType, string[]>> = {
  "alert.fired": ["system.disk-alert", "app.oom-killed"],
  "alert.resolved": ["system.disk-alert"],
  "backup.summary": ["backup.success", "backup.failed"],
};

/** Whether a channel's subscribedEvents filter allows this event. Empty means all. */
export function channelAcceptsEvent(subscribedEvents: string[], eventType: BusEventType): boolean {
  if (subscribedEvents.length === 0) return true;
  if (subscribedEvents.includes(eventType)) return true;
  return (REPLACED_EVENT_TYPES[eventType] ?? []).some((old) => subscribedEvents.includes(old));
}
