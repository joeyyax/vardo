// Urgent or routine: the one place that decides what may raise the global bar.
// The bar shows urgent items only. The Projects stats carry the routine ones. The panel lists both.

import type { AppCondition } from "@/lib/docker/conditions";
import type { BusEventType } from "@/lib/bus/events";

/** Broken right now and needs a person. Anything else is routine. */
export type UrgentReason =
  | "app-down"
  | "vardo-degraded"
  | "deploy-failed"
  | "backup-failed"
  | "security-critical"
  | "anomaly"
  | "cert";

/** A failed deploy stays urgent this long, while it is still the app's latest. */
export const URGENT_DEPLOY_WINDOW_MS = 60 * 60 * 1000;

/** The notification behind each reason. Every one is delivered immediately. */
export const URGENT_EVENTS: Record<UrgentReason, BusEventType[]> = {
  "app-down": ["app.auto-restarted", "system.restart-loop"],
  "vardo-degraded": ["system.service-down"],
  "deploy-failed": ["deploy.failed"],
  "backup-failed": ["backup.failed"],
  "security-critical": ["security.file-exposed"],
  anomaly: ["alert.fired"],
  cert: ["system.cert-expiring"],
};

/** What every urgency check reads about an app. */
export type LiveSubject = { parked?: boolean | null; status: string };

/** Stopped on purpose: never urgent, whatever else it reports. */
export function isQuiet(app: LiveSubject): boolean {
  return !!app.parked || app.status === "stopped";
}

/** Crashed, or its container is gone, while meant to run. */
export function appDownUrgent(app: LiveSubject): boolean {
  return !isQuiet(app) && (app.status === "error" || app.status === "missing");
}

/** Which conditions are urgent: crash loops, critical findings and certificates near or past expiry. */
export function conditionUrgent(c: Pick<AppCondition, "kind" | "severity">, app: LiveSubject): boolean {
  if (isQuiet(app)) return false;
  switch (c.kind) {
    case "crash-looping":
    case "self-heal-exhausted":
      return true;
    case "security-findings":
      return c.severity === "critical";
    case "cert-expired":
      return true;
    case "cert-expiring":
      return c.severity === "critical";
    default:
      return false;
  }
}

/** A failed deploy that is the app's latest and failed within the window. */
export function deployFailureUrgent(
  latest: { status: string; startedAt: Date | string; finishedAt?: Date | string | null } | null | undefined,
  app: LiveSubject,
  now: number,
): boolean {
  if (!latest || latest.status !== "failed" || isQuiet(app)) return false;
  const at = new Date(latest.finishedAt ?? latest.startedAt).getTime();
  return now - at <= URGENT_DEPLOY_WINDOW_MS;
}

/** Row keys whose items are urgent whenever they appear: Vardo's own health and standing failures. */
export const URGENT_ROW_KEYS: Partial<Record<string, UrgentReason>> = {
  "core-service-down": "vardo-degraded",
  "vardo-stack-degraded": "vardo-degraded",
  "vardo-unreachable": "vardo-degraded",
  "backup-failed": "backup-failed",
  anomaly: "anomaly",
};
