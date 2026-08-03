import type { BusEvent, BusEventType } from "@/lib/bus/events";

/**
 * Event types that only ever drive the live UI. They fire many times per run
 * and carry no standalone meaning.
 *
 * WARNING: a UI-only event added anywhere else reaches every enabled channel —
 * an empty subscribedEvents filter matches everything and email defaults on.
 */
export const SILENT_EVENT_TYPES: ReadonlySet<BusEventType> = new Set([
  "backup.progress",
] as BusEventType[]);

/**
 * Whether an event is for the UI alone. A deploy start would otherwise be one
 * extra email or webhook per deploy, so channels get terminal outcomes.
 */
export function isUiOnlyEvent(event: BusEvent): boolean {
  if (SILENT_EVENT_TYPES.has(event.type)) return true;
  return event.type === "deploy.status" && event.status === "running";
}
