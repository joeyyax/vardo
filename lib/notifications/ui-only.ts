import type { BusEvent, BusEventType } from "@/lib/bus/events";

/**
 * Event types that only drive the live UI.
 * Add UI-only events here, or they reach every enabled channel.
 */
export const SILENT_EVENT_TYPES: ReadonlySet<BusEventType> = new Set([
  "backup.progress",
  "deploy.status",
] as BusEventType[]);

/** Whether an event is for the UI alone. */
export function isUiOnlyEvent(event: BusEvent): boolean {
  return SILENT_EVENT_TYPES.has(event.type);
}
