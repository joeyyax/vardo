import type { BusEvent } from "@/lib/bus/events";
import type { IncidentRef } from "./types";

/** The incident an event is about when it covers exactly one. */
export function singleIncident(event: BusEvent): IncidentRef | undefined {
  if (event.incident) return event.incident;
  if ((event.type === "alert.fired" || event.type === "alert.resolved") && event.alerts.length === 1) return event.alerts[0].incident;
  return undefined;
}
