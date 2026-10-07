// Dispatches bus events to the org's notification channels and the real-time event bus.

export { emit } from "@/lib/notifications/dispatch";
export type { BusEvent, BusEventType } from "@/lib/bus";
