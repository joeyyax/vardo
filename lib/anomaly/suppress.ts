// Quiet windows: an app's deploys, restarts and backups, and a grace period after each.

import { and, gt, isNotNull, isNull, or } from "drizzle-orm";
import { onEmit } from "@/lib/bus";
import { db } from "@/lib/db";
import { backups, deployments } from "@/lib/db/schema";

/** Quiet this long after the work ends. */
export const QUIET_GRACE_MS = 30 * 60_000;
/** Work that never recorded an end stops counting after this. */
const STUCK_MS = 6 * 60 * 60_000;

export type Window = { appId: string; start: number; end: number | null };

/** Whether `now` falls in a window or its grace period. */
export function inQuietWindow(windows: Window[], now: number, graceMs = QUIET_GRACE_MS): boolean {
  return windows.some((w) => w.start <= now && (w.end === null ? now - w.start < STUCK_MS : now - w.end < graceMs));
}

/** Apps whose own windows, or their stack's, cover `now`. */
export function quietApps(windows: Window[], now: number, graceMs = QUIET_GRACE_MS): Set<string> {
  const byApp = new Map<string, Window[]>();
  for (const w of windows) byApp.set(w.appId, [...(byApp.get(w.appId) ?? []), w]);
  return new Set([...byApp].filter(([, ws]) => inQuietWindow(ws, now, graceMs)).map(([id]) => id));
}

// Restarts and state changes this process saw, by app.
const globalForActivity = globalThis as unknown as { __vardo_anomaly_activity?: Map<string, number> };
const activity: Map<string, number> = (globalForActivity.__vardo_anomaly_activity ??= new Map());

export function markActivity(appId: string, at: number): void {
  activity.set(appId, Math.max(activity.get(appId) ?? 0, at));
}

export function resetActivity(): void {
  activity.clear();
}

/** In-process activity as windows, dropping what's past the grace period. */
export function activityWindows(now: number): Window[] {
  const out: Window[] = [];
  for (const [appId, at] of activity) {
    if (now - at >= QUIET_GRACE_MS) activity.delete(appId);
    else out.push({ appId, start: at, end: at });
  }
  return out;
}

onEmit("anomaly-quiet", (_orgId, event) => {
  const appId = "appId" in event ? event.appId : null;
  if (!appId) return;
  switch (event.type) {
    case "deploy.status":
    case "app.auto-restarted":
    case "app.state-changed":
    case "app.oom-killed":
    case "backup.progress":
      markActivity(appId, Date.now());
  }
});

/** Deploys and backups that ran recently or are running, from the database. */
export async function recentWorkWindows(now: number): Promise<Window[]> {
  const since = new Date(now - STUCK_MS);
  const ended = new Date(now - QUIET_GRACE_MS);
  const [deploys, runs] = await Promise.all([
    db
      .select({ appId: deployments.appId, start: deployments.startedAt, end: deployments.finishedAt })
      .from(deployments)
      .where(and(gt(deployments.startedAt, since), or(isNull(deployments.finishedAt), gt(deployments.finishedAt, ended)))),
    db
      .select({ appId: backups.appId, start: backups.startedAt, end: backups.finishedAt })
      .from(backups)
      .where(and(isNotNull(backups.appId), gt(backups.startedAt, since), or(isNull(backups.finishedAt), gt(backups.finishedAt, ended)))),
  ]);
  return [...deploys, ...runs].flatMap((r) =>
    r.appId ? [{ appId: r.appId, start: r.start.getTime(), end: r.end ? r.end.getTime() : null }] : [],
  );
}
