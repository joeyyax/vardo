// What an automatic monitor runs with: the detected path, the operator's answer and their edits, over the address the domain gives it.

import type { UptimeMonitorRow, uptimeMonitors } from "@/lib/db/schema";
import { AUTO_EXPECTED_STATUS, DEFAULT_HTTP_TIMEOUT_MS, type AutoOverrides, type HttpCheck, type ReviewAnswer } from "./core";
import { UptimeInputError } from "./errors";
import type { UpdateMonitorInput } from "./types";

/** The expected status an automatic monitor runs with: the operator's edit, then their answer, else any response below 500. */
export function expectedStatusFor(row: { reviewAnswer: ReviewAnswer | null; overrides?: AutoOverrides | null }): { min: number; max: number } {
  if (row.overrides?.expectedStatus) return { ...row.overrides.expectedStatus };
  const answer = row.reviewAnswer;
  return answer?.kind === "status" ? { min: answer.status, max: answer.status } : { ...AUTO_EXPECTED_STATUS };
}

/** The check an automatic monitor should run for a base address: detected or pinned path, with the operator's edits applied. */
export function autoCheckFor(row: Pick<UptimeMonitorRow, "healthPath" | "reviewAnswer" | "overrides">, base: string): HttpCheck {
  const ov = row.overrides ?? {};
  return {
    type: "http",
    url: base + (ov.path ?? row.healthPath ?? ""),
    expectedStatus: expectedStatusFor(row),
    timeoutMs: ov.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    ...(ov.keyword ? { keyword: ov.keyword } : {}),
  };
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
    return {
      overrides: null,
      reviewAnswer: null,
      ...(row.reviewAnswer?.kind === "skip" ? { enabled: true } : {}),
      intervalSec: 60,
      healthDueAt: null,
      healthPath: row.overrides?.path !== undefined ? null : row.healthPath,
      healthSource: row.overrides?.path !== undefined ? null : row.healthSource,
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
  if (patch.intervalSec !== undefined) {
    ov.intervalSec = patch.intervalSec;
    set.intervalSec = patch.intervalSec;
  }
  set.overrides = Object.keys(ov).length > 0 ? ov : null;
  return set;
}
