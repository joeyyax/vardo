// What an automatic monitor runs with: the detected path, the operator's answer and their edits, over the address the domain gives it.

import { apps, type UptimeMonitorRow, type uptimeMonitors } from "@/lib/db/schema";
import { AUTO_EXPECTED_STATUS, DEFAULT_HTTP_TIMEOUT_MS, DEFAULT_INTERVAL, HOMEPAGE_INTERVAL, type AutoOverrides, type HttpCheck, type IntervalSec, type ReviewAnswer } from "./core";
import { UptimeInputError } from "./errors";
import type { UpdateMonitorInput } from "./types";

/** The expected status an automatic monitor runs with: the operator's edit, then their answer, else any response below 500. */
export function expectedStatusFor(row: { reviewAnswer: ReviewAnswer | null; overrides?: AutoOverrides | null }): { min: number; max: number } {
  if (row.overrides?.expectedStatus) return { ...row.overrides.expectedStatus };
  const answer = row.reviewAnswer;
  const status = answer?.kind === "status" || answer?.kind === "path" ? answer.status : undefined;
  return status !== undefined ? { min: status, max: status } : { ...AUTO_EXPECTED_STATUS };
}

/** What decides whether an app is meant to be down. */
export type AppRunState = { status: string | null; parked: boolean | null; lastRunningAt: Date | null; exitReason?: { signal?: string } | null };

/**
 * An app someone stopped or never started: its monitors aren't checked, don't alert and show as stopped.
 * Reads status-reconcile's verdict: a non-zero exit or OOM kill is "error", a stop signal is "stopped". `parked` is set by Vardo's stop action.
 * A crash (error, or a SIGSEGV stop) and a container that vanished after running stay outages unless the operator stopped the app.
 */
export function appNotRunning(app: AppRunState | null | undefined): boolean {
  if (!app?.status) return false;
  if (app.parked && (app.status === "stopped" || app.status === "error" || app.status === "missing")) return true;
  if (app.status === "stopped") return app.exitReason?.signal !== "SIGSEGV";
  return app.status === "missing" && !app.lastRunningAt;
}

/** The app columns `appNotRunning` reads, for a select. */
export const runStateColumns = { status: apps.status, parked: apps.parked, lastRunningAt: apps.lastRunningAt, exitReason: apps.exitReason };

/** How often an automatic monitor runs: the operator's edit, else less often when it checks the homepage. */
export function autoIntervalFor(row: { healthSource: string | null; overrides?: AutoOverrides | null }): IntervalSec {
  return row.overrides?.intervalSec ?? (row.healthSource === "homepage" ? HOMEPAGE_INTERVAL : DEFAULT_INTERVAL);
}

/** The check an automatic monitor should run for a base address: detected or pinned path, with the operator's edits applied. */
export function autoCheckFor(row: Pick<UptimeMonitorRow, "healthPath" | "reviewAnswer" | "overrides">, base: string): HttpCheck {
  const ov = row.overrides ?? {};
  const answer = row.reviewAnswer;
  const method = answer?.kind === "status" || answer?.kind === "path" ? answer.method : undefined;
  return {
    type: "http",
    url: base + (ov.path ?? row.healthPath ?? ""),
    ...(method && method !== "GET" ? { method } : {}),
    expectedStatus: expectedStatusFor(row),
    timeoutMs: ov.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    ...(ov.keyword ? { keyword: ov.keyword } : {}),
  };
}

/** The check with the fields an automatic monitor derives replaced, keeping anything else it carries. */
export function withAutoFields(prev: HttpCheck, next: HttpCheck): HttpCheck {
  const { method: _method, keyword: _keyword, ...rest } = prev;
  return { ...rest, url: next.url, expectedStatus: next.expectedStatus, timeoutMs: next.timeoutMs, ...(next.method ? { method: next.method } : {}), ...(next.keyword ? { keyword: next.keyword } : {}) };
}

/** True when two checks run the same request with the same expectations. */
export function sameAutoFields(a: HttpCheck, b: HttpCheck): boolean {
  return a.url === b.url && (a.method ?? "GET") === (b.method ?? "GET") && a.expectedStatus.min === b.expectedStatus.min && a.expectedStatus.max === b.expectedStatus.max && a.timeoutMs === b.timeoutMs && a.keyword === b.keyword;
}

/** The monitor's URL without its health path. */
export function baseUrlOf(row: Pick<UptimeMonitorRow, "check" | "healthPath">): string | null {
  if (row.check.type !== "http") return null;
  const { url } = row.check;
  return row.healthPath && url.endsWith(row.healthPath) ? url.slice(0, -row.healthPath.length) : url;
}

type MonitorChanges = Partial<typeof uptimeMonitors.$inferInsert>;

const SAFE_PATH = /^(\/[A-Za-z0-9._~/%-]{0,199})?$/;
const EDITABLE = ["name", "path", "expectedStatus", "timeoutMs", "keyword", "intervalSec"] as const;

/** True when the patch changes something an edit can override on an automatic monitor. */
export const editsAuto = (patch: UpdateMonitorInput & { resetOverrides?: boolean }) => EDITABLE.some((k) => k in patch) || !!patch.resetOverrides;

/**
 * Row changes for an edit of an automatic monitor. The target host stays the domain's; what the operator changes is kept
 * as an override that sync and detection leave alone. `resetOverrides` clears them and the review answer.
 */
export function autoEdit(row: UptimeMonitorRow, patch: UpdateMonitorInput & { resetOverrides?: boolean }): MonitorChanges {
  if (row.check.type !== "http") throw new UptimeInputError("Only HTTP monitors can be edited.");
  for (const k of ["type", "url", "host", "port", "warnDays"] as const) {
    if (k in patch) throw new UptimeInputError("An automatic monitor's address follows its domain. Change the path instead.");
  }
  if (patch.resetOverrides) {
    const healthSource = row.overrides?.path !== undefined ? null : row.healthSource;
    return {
      overrides: null,
      reviewAnswer: null,
      ...(row.reviewAnswer?.kind === "skip" ? { enabled: true } : {}),
      intervalSec: autoIntervalFor({ healthSource }),
      healthDueAt: null,
      healthPath: row.overrides?.path !== undefined ? null : row.healthPath,
      healthSource,
      reviewStatus: null,
      reviewReason: null,
    };
  }

  const ov: AutoOverrides = { ...(row.overrides ?? {}) };
  const set: MonitorChanges = {};
  if ("name" in patch) {
    if (patch.name) {
      ov.name = patch.name;
      set.name = patch.name;
    }
    else delete ov.name;
  }
  if (patch.path !== undefined) {
    if (!SAFE_PATH.test(patch.path)) throw new UptimeInputError("Enter a path that starts with /, or leave it empty for the homepage.");
    ov.path = patch.path;
    set.healthPath = patch.path || null;
    set.healthSource = patch.path ? "probe" : "homepage";
    set.reviewStatus = null;
    set.reviewReason = null;
  }
  if (patch.expectedStatus) {
    if (patch.expectedStatus.max < patch.expectedStatus.min) throw new UptimeInputError("The status range ends before it starts.");
    ov.expectedStatus = patch.expectedStatus;
    set.reviewStatus = null;
    set.reviewReason = null;
  }
  if ("keyword" in patch) {
    if (patch.keyword) ov.keyword = patch.keyword;
    else delete ov.keyword;
  }
  if (patch.timeoutMs !== undefined) ov.timeoutMs = patch.timeoutMs;
  if (patch.intervalSec !== undefined) ov.intervalSec = patch.intervalSec;
  set.overrides = Object.keys(ov).length > 0 ? ov : null;
  set.intervalSec = autoIntervalFor({ healthSource: set.healthSource === undefined ? row.healthSource : set.healthSource, overrides: set.overrides });
  return set;
}
