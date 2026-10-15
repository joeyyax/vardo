// How each notification type reaches an inbox: now, as one email per run, or only in the digest.

import type { BusEvent, BusEventType } from "@/lib/bus/events";
import type { NotificationCategory } from "./registry";

export type DeliveryClass =
  /** Needs action now: one email as it happens. */
  | "immediate"
  /** One email per run, only when something is new or wrong. The producer batches and filters. */
  | "batch"
  /** Successes and routine runs: the digest counts them, email leaves them out. */
  | "digest";

/** Defaults per event type. Unlisted types are immediate. */
export const DELIVERY_DEFAULTS: Partial<Record<BusEventType, DeliveryClass>> = {
  "deploy.success": "digest",
  "backup.run-started": "digest",
  "backup.summary": "batch",
  "security.scan-findings": "batch",
  "app.auto-restarted": "immediate",
  "system.integration-permissions": "immediate",
};

export function deliveryClass(type: BusEventType): DeliveryClass {
  return DELIVERY_DEFAULTS[type] ?? "immediate";
}

type Settings = { categories: Partial<Record<NotificationCategory, boolean>> };

/** Vardo back within this long was a quick restart: one "back up" email, no "stopped" one. */
export const QUICK_RESTART_SECONDS = 10 * 60;

function longStop(downSeconds: number | undefined): boolean {
  return downSeconds === undefined || downSeconds >= QUICK_RESTART_SECONDS;
}

/** Whether an event goes out by email. Digest-only events still email when a person started them or the org opted in. */
export function emailsEvent(event: BusEvent, settings: Settings): boolean {
  switch (event.type) {
    case "deploy.success":
      return event.trigger === "manual" || settings.categories.deploySuccess === true;
    case "app.auto-restarted":
      // A restart that recovered is self-healing; the digest counts it.
      return event.gaveUp || !event.success;
    case "alert.resolved":
      return !event.quiet && !event.held;
    // Only outcomes email: the boot, the restart or the update result says what happened.
    case "system.shutdown":
    case "system.restarting":
    case "system.update-started":
    case "system.rollout-started":
    case "system.rollout-busy":
      return false;
    case "system.restarted":
      return event.target !== "services";
    case "system.started":
      return !(event.unclean && longStop(event.downSeconds));
    case "system.recovered-unclean":
      return longStop(event.downSeconds);
    case "system.updated":
    case "system.update-failed":
      return !event.rolloutId;
    default:
      return deliveryClass(event.type) !== "digest";
  }
}

/** Event types whose email depends on org settings, so the channel only reads them when needed. */
export function needsSettings(event: BusEvent): boolean {
  return event.type === "deploy.success";
}
