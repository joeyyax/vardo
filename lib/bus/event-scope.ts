// Whether each event belongs to apps (and so their projects) or to the whole org.

import type { BusEvent, BusEventType } from "./events";

/** Every channel gets it, whatever its project filter. */
export const ORG_LEVEL = "org" as const;

type AppIds = (string | null | undefined)[];
type ScopeOf<T extends BusEventType> = typeof ORG_LEVEL | ((event: Extract<BusEvent, { type: T }>) => AppIds | typeof ORG_LEVEL);

/** Each event type's scope: org-level, or the apps it's about. */
export const EVENT_SCOPES: { [T in BusEventType]: ScopeOf<T> } = {
  "deploy.success": (e) => [e.appId],
  "deploy.failed": (e) => [e.appId],
  "deploy.incomplete": (e) => [e.appId],
  "deploy.rollback": (e) => [e.appId],
  "deploy.status": (e) => [e.appId],
  "app.state-changed": (e) => [e.appId],
  "app.auto-restarted": (e) => [e.appId],
  "app.oom-killed": (e) => [e.appId],
  "cron.failed": (e) => [e.appId],
  "volume.drift": (e) => [e.appId],
  "disk.write-alert": (e) => [e.appId],
  "backup.progress": (e) => [e.appId],
  "backup.run-started": (e) => e.apps.map((a) => a.appId),
  "backup.summary": (e) => [
    ...e.rows.map((r) => r.appId),
    ...Object.values(e.run.unfinishedAppIds ?? {}),
  ],
  "security.scan-findings": (e) => e.apps?.map((a) => a.appId) ?? [e.appId],
  "security.domain-claimed": (e) => e.appIds,
  "system.cert-expiring": (e) => [e.app?.id],
  "digest.app-recap": (e) => e.recaps.map((r) => r.appId),
  // A host alert in the batch makes the whole notice org-level.
  "alert.fired": (e) => (e.alerts.some((a) => !a.appId) ? ORG_LEVEL : e.alerts.map((a) => a.appId)),
  "alert.resolved": (e) => (e.alerts.some((a) => !a.appId) ? ORG_LEVEL : e.alerts.map((a) => a.appId)),
  "security.file-exposed": ORG_LEVEL,
  "backup.success": ORG_LEVEL,
  "backup.failed": ORG_LEVEL,
  "digest.health": ORG_LEVEL,
  "org.invitation-sent": ORG_LEVEL,
  "org.invitation-accepted": ORG_LEVEL,
  "system.service-down": ORG_LEVEL,
  "system.restart-loop": ORG_LEVEL,
  "system.update-available": ORG_LEVEL,
  "system.integration-permissions": ORG_LEVEL,
  "system.shutdown": ORG_LEVEL,
  "system.started": ORG_LEVEL,
  "system.recovered-unclean": ORG_LEVEL,
  "system.update-started": ORG_LEVEL,
  "system.updated": ORG_LEVEL,
  "system.update-failed": ORG_LEVEL,
  "system.rollout-started": ORG_LEVEL,
  "system.rollout-busy": ORG_LEVEL,
  "system.rollout-paused": ORG_LEVEL,
  "system.rollout-finished": ORG_LEVEL,
  "system.restarting": ORG_LEVEL,
  "system.restarted": ORG_LEVEL,
  "system.restart-failed": ORG_LEVEL,
  "system.containers-missing": ORG_LEVEL,
  "notification.test": ORG_LEVEL,
};

/** The app ids an event is about, or null when it's org-level or names no app. */
export function eventAppIds(event: BusEvent): string[] | null {
  const scope = EVENT_SCOPES[event.type] as ScopeOf<BusEventType> | undefined;
  if (!scope || scope === ORG_LEVEL) return null;
  const ids = (scope as (e: BusEvent) => AppIds | typeof ORG_LEVEL)(event);
  if (ids === ORG_LEVEL) return null;
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
  return unique.length > 0 ? unique : null;
}
