// Splits a check into updates within the running major and new major versions.
// Majors are informational; only a resurface reason brings one back as attention.

import { isMajorJump, majorOf } from "./migration-path";
import { classifyBump, compareTags, type BumpSeverity } from "./tag-version";
import { eolNotice, type EolNotice } from "./eol";

export interface SplitCheck {
  /** Newest tag within the running major. */
  latestTag: string | null;
  severity: BumpSeverity | null;
  /** Newer tags within the running major, newest first. */
  available: string[];
  /** Newest tag on a higher major. */
  majorAvailable: string | null;
  /** Every tag on a higher major, newest first. */
  majorTags: string[];
}

/** Partitions cached tags by major. Older rows may carry a major in `latestTag`. */
export function splitCheck(
  currentTag: string,
  row: {
    latestTag: string | null;
    severity: BumpSeverity | null;
    available: string[];
    majorAvailable: string | null;
  },
): SplitCheck {
  const within = row.available.filter((tag) => !isMajorJump(currentTag, tag));
  const majorTags = row.available.filter((tag) => isMajorJump(currentTag, tag));

  let latestTag = row.latestTag;
  let severity = row.severity;
  let majorAvailable = row.majorAvailable;

  if (latestTag && isMajorJump(currentTag, latestTag)) {
    if (!majorAvailable || (compareTags(latestTag, majorAvailable) ?? 0) > 0) majorAvailable = latestTag;
    latestTag = within[0] ?? null;
    severity = latestTag ? classifyBump(currentTag, latestTag) : null;
  }
  if (latestTag && !within.includes(latestTag)) within.unshift(latestTag);
  if (majorAvailable && !majorTags.includes(majorAvailable)) majorTags.unshift(majorAvailable);

  return { latestTag, severity, available: within, majorAvailable, majorTags };
}

/** Advisory that a fix only ships in a newer major. */
export interface SecurityAdvisory {
  summary: string;
  /** Tag or major that carries the fix. */
  fixedIn: string;
  url?: string;
}

export type ResurfaceReason =
  | { kind: "eol"; notice: EolNotice }
  | { kind: "security"; advisory: SecurityAdvisory };

/** Hook for a future advisory feed. Returns null until one is wired. */
export type SecurityAdvisor = (input: {
  image: string;
  currentTag: string;
  majorAvailable: string | null;
}) => SecurityAdvisory | null;

let advisor: SecurityAdvisor = () => null;

export function setSecurityAdvisor(next: SecurityAdvisor | null): void {
  advisor = next ?? (() => null);
}

/** Reasons a held or offered major needs a decision now. Empty means stay quiet. */
export function resurfaceReasons(
  service: { image: string; currentTag: string; majorAvailable: string | null },
  now: number = Date.now(),
): ResurfaceReason[] {
  const reasons: ResurfaceReason[] = [];
  const notice = eolNotice(service.image, service.currentTag, now);
  if (notice) reasons.push({ kind: "eol", notice });
  const advisory = advisor(service);
  if (advisory) reasons.push({ kind: "security", advisory });
  return reasons;
}

/** Running major from a version tag, or null for floating tags. */
export function runningMajor(tag: string): number | null {
  return majorOf(tag);
}
