import type { BusEvent, BusEventType } from "./events";

export type ToastSeverity = "success" | "error" | "warning" | "info";

/**
 * Event types that auto-toast. Low-signal events (digests, invitations,
 * update notices) are excluded — they belong in a notification panel, not
 * interrupting the user mid-session.
 */
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
  "system.disk-alert": "error",
  "system.restart-loop": "error",
  "system.cert-expiring": "error",
};

/** Toast severity for an event, or undefined when it should not toast. */
export function toastSeverityFor(event: BusEvent): ToastSeverity | undefined {
  // A self-heal that gave up stopped defending the app — that needs attention.
  if (event.type === "app.auto-restarted" && event.gaveUp) return "error";
  return TOAST_EVENTS[event.type];
}
