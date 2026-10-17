// Whether an app is down on purpose. Uptime and backups both read it.

import { apps } from "@/lib/db/schema";

/** What decides whether an app is meant to be down. */
export type AppRunState = { status: string | null; parked: boolean | null; lastRunningAt: Date | null; exitReason?: { signal?: string } | null };

/**
 * An app someone stopped or never started: nothing should alert about it being down.
 * Reads status-reconcile's verdict: a non-zero exit or OOM kill is "error", a stop signal is "stopped". `parked` is set by Vardo's stop action.
 * A crash (error, or a SIGSEGV stop) and a container that vanished after running stay outages unless the operator stopped the app.
 */
export function appNotRunning(app: AppRunState | null | undefined): boolean {
  if (!app?.status) return false;
  // Stop sets parked before the containers go; start and deploy clear it.
  if (app.parked && app.status !== "deploying") return true;
  if (app.status === "stopped") return app.exitReason?.signal !== "SIGSEGV";
  return app.status === "missing" && !app.lastRunningAt;
}

/** The app columns `appNotRunning` reads, for a select. */
export const runStateColumns = { status: apps.status, parked: apps.parked, lastRunningAt: apps.lastRunningAt, exitReason: apps.exitReason };
