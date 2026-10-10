import type { BusEvent, BusEventType } from "./events";

export type ToastSeverity = "success" | "error" | "warning" | "info";

/** Event types that auto-toast. */
export const TOAST_EVENTS: Partial<Record<BusEventType, ToastSeverity>> = {
  "deploy.success": "success",
  "deploy.failed": "error",
  "deploy.incomplete": "warning",
  "deploy.rollback": "error",
  "app.auto-restarted": "info",
  "app.oom-killed": "error",
  "backup.success": "success",
  "backup.failed": "error",
  "cron.failed": "error",
  "disk.write-alert": "error",
  "system.service-down": "error",
  "system.restart-loop": "error",
  "system.cert-expiring": "error",
  "system.integration-permissions": "warning",
};

/** Toast severity for an event, or undefined when it should not toast. */
export function toastSeverityFor(event: BusEvent): ToastSeverity | undefined {
  // A self-heal that gave up needs attention.
  if (event.type === "app.auto-restarted" && event.gaveUp) return "error";
  if (event.type === "alert.fired") return event.alerts.some((a) => a.severity === "critical") ? "error" : "warning";
  return TOAST_EVENTS[event.type];
}
