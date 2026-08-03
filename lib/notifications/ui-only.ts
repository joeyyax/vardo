import type { BusEvent } from "@/lib/bus/events";

/**
 * Events that exist only to drive the live UI. A deploy start would otherwise
 * be one extra email or webhook per deploy, so channels get terminal outcomes.
 */
export function isUiOnlyEvent(event: BusEvent): boolean {
  return event.type === "deploy.status" && event.status === "running";
}
