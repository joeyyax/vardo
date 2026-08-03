// ---------------------------------------------------------------------------
// Which idle apps may have their images reclaimed, and which never may.
//
// Reclamation deletes images only. Volumes are app data and are out of scope —
// nothing in this module or its callers names a volume.
//
// This is not `docker image prune -a`. Prune reclaims by "nothing references
// this right now", which deletes images a currently-stopped app still needs.
// Scope here is app inactivity, and re-pull has to be deterministic.
// ---------------------------------------------------------------------------

import { parseImageRef, type ImageRef } from "../image-updates/image-ref";
import { isMajorLocked } from "../image-updates/stateful-image";

/** Days an app must be idle before its images are eligible, when unset. */
export const DEFAULT_IDLE_DAYS = 30;

export const MIN_IDLE_DAYS = 1;
export const MAX_IDLE_DAYS = 3650;

/** Per-app override of the instance policy. */
export type ReclaimPolicy = "auto" | "never" | "always";

export type ImageSafety =
  /** Digest-pinned, or a tag naming at least a major and minor. Re-pull is deterministic. */
  | "pinned"
  /** Re-pull resolves to whatever the tag points at that day. */
  | "floating"
  /** Major-locked engine without a digest pin. Re-pull can cross a major. */
  | "stateful-unpinned";

export type SkipReason =
  | "self"
  | "system-managed"
  | "pinned-by-user"
  | "running"
  | "error"
  | "not-idle"
  | "never-run"
  | "compose-unavailable"
  | "builds-locally"
  | "floating-tag"
  | "stateful-floating"
  | "no-images";

/**
 * A tag is treated as pinned when it names at least a major and a minor.
 * `1.8.1`, `v3.6` and `8.0.45-1.el9` qualify; `16`, `v3`, `alpine` and `latest`
 * do not, because they move.
 */
export function isVersionPinnedTag(tag: string): boolean {
  return /^v?\d+\.\d+/.test(tag);
}

/**
 * How safe re-pulling this reference is.
 *
 * Major-locked engines need a digest to count as pinned. `mysql:8.0` looks
 * specific but still moves within 8.0.x, and the failure mode for these images
 * is the container refusing to start against its data directory.
 */
export function classifyImage(ref: ImageRef): ImageSafety {
  if (ref.digest) return "pinned";
  if (isMajorLocked(ref.repository)) return "stateful-unpinned";
  return isVersionPinnedTag(ref.tag) ? "pinned" : "floating";
}

/** Whether an image may be reclaimed under this app's policy. */
export function imageReclaimable(safety: ImageSafety, policy: ReclaimPolicy): boolean {
  if (safety === "stateful-unpinned") return false;
  if (safety === "pinned") return true;
  return policy === "always";
}

/** Skip reason for an image that may not be reclaimed. */
export function imageSkipReason(safety: ImageSafety): SkipReason {
  return safety === "stateful-unpinned" ? "stateful-floating" : "floating-tag";
}

/** Whole days between two instants, floored. Negative clock skew reads as 0. */
export function idleDays(lastRunningAt: Date | null, now: Date): number | null {
  if (!lastRunningAt) return null;
  const ms = now.getTime() - lastRunningAt.getTime();
  return ms <= 0 ? 0 : Math.floor(ms / 86_400_000);
}

/** Threshold for one app: its override, else the instance default. */
export function resolveIdleThreshold(
  override: number | null | undefined,
  instanceDefault: number,
): number {
  const value = override ?? instanceDefault;
  return Math.min(MAX_IDLE_DAYS, Math.max(MIN_IDLE_DAYS, Math.floor(value)));
}

/** Compose declaring a `build:` produces an image no registry can return. */
export function composeBuilds(yamlContent: string): boolean {
  return /^\s{2,}build\s*:/m.test(yamlContent);
}

/** Human-readable explanation, used verbatim in the preview and the report. */
export const SKIP_COPY: Record<SkipReason, string> = {
  self: "Vardo itself",
  "system-managed": "Managed by Vardo",
  "pinned-by-user": "Pinned — reclamation turned off for this app",
  running: "Currently running",
  error: "In an error state — left alone until it is understood",
  "not-idle": "Not idle long enough",
  "never-run": "Never observed running",
  "compose-unavailable": "Compose file not readable — cannot rule out a local build",
  "builds-locally": "Built from source — a reclaimed image cannot be pulled back",
  "floating-tag": "Floating tag — re-pull would install a different version",
  "stateful-floating":
    "Stateful image without a pinned version — re-pull could cross a major and the container would refuse to start",
  "no-images": "No reclaimable images",
};

/** Parse and classify one image reference. Unparsable refs are treated as floating. */
export function classifyRef(image: string): { ref: ImageRef | null; safety: ImageSafety } {
  const ref = parseImageRef(image);
  if (!ref) return { ref: null, safety: "floating" };
  return { ref, safety: classifyImage(ref) };
}
