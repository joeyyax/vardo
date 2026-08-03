// ---------------------------------------------------------------------------
// Deploy-time gate for major-locked images whose tag names no version.
//
// `postgres:latest` rolling 16 → 18 swaps the engine with nothing in the tag to
// notice. The new container exits on its version check against the existing
// data directory, so the deploy is stopped while the old slot is still serving
// rather than after it has been replaced.
// ---------------------------------------------------------------------------

import { parseImageRef } from "./image-ref";
import { isMajorLocked } from "./stateful-image";
import { parseTag } from "./tag-version";
import { migrationPathFor, planMigration, type MigrationPlan } from "./migration-path";
import type { ImageMajor } from "./image-major";

export interface MajorGateCandidate {
  /** Compose service. Null for single-image apps. */
  service: string | null;
  /** Ref as pinned, e.g. `postgres:latest`. */
  image: string;
  tag: string;
}

/**
 * Services whose data format is tied to a major and whose tag does not name
 * one. Covers `latest` and bare flavors like `alpine` alike — neither carries a
 * version to compare, which is the whole condition. Digest pins are immutable.
 */
export function majorGateCandidates(
  services: { service: string | null; image: string | null | undefined }[],
): MajorGateCandidate[] {
  const found: MajorGateCandidate[] = [];
  for (const { service, image } of services) {
    if (!image) continue;
    const ref = parseImageRef(image);
    if (!ref || ref.digest) continue;
    if (!isMajorLocked(ref.repository)) continue;
    if (parseTag(ref.tag).kind === "version") continue;
    found.push({ service, image, tag: ref.tag });
  }
  return found;
}

export type MajorGateVerdict =
  | { kind: "ok"; candidate: MajorGateCandidate; major: number }
  | { kind: "unknown"; candidate: MajorGateCandidate; reason: string }
  | { kind: "changed"; candidate: MajorGateCandidate; from: number; to: number };

/**
 * Compare the major read before the pull against the one read after.
 *
 * Either side missing is "cannot say", never "no change" — a gate that fires on
 * uncertainty is a gate people turn off.
 */
export function majorGateVerdict(
  candidate: MajorGateCandidate,
  before: ImageMajor | null,
  after: ImageMajor | null,
): MajorGateVerdict {
  if (!before && !after) {
    return { kind: "unknown", candidate, reason: "no version on the image before or after the pull" };
  }
  if (!before) {
    return { kind: "unknown", candidate, reason: "nothing local to compare against before the pull" };
  }
  if (!after) {
    return { kind: "unknown", candidate, reason: "no version on the pulled image" };
  }
  if (before.major === after.major) return { kind: "ok", candidate, major: after.major };
  return { kind: "changed", candidate, from: before.major, to: after.major };
}

/** One service the gate stopped, with the recipe for moving it. */
export interface BlockedService {
  service: string | null;
  image: string;
  from: number;
  to: number;
  engine: string;
  plan: MigrationPlan | null;
}

/** What the gate stopped, held until the app deploys or the tag is pinned. */
export interface MajorGateBlock {
  appId: string;
  appName: string;
  deploymentId: string;
  blockedAt: string;
  services: BlockedService[];
}

export function blockedService(verdict: Extract<MajorGateVerdict, { kind: "changed" }>): BlockedService {
  const { candidate, from, to } = verdict;
  return {
    service: candidate.service,
    image: candidate.image,
    from,
    to,
    engine: migrationPathFor(candidate.image)?.engine ?? candidate.image,
    plan: planMigration(candidate.image, String(from), String(to)),
  };
}

function name(entry: { service: string | null; image: string }): string {
  return entry.service ? `${entry.service} (${entry.image})` : entry.image;
}

/**
 * The deploy log's account of the block. Says where the deploy stopped, what is
 * still serving, and what the new container would actually do.
 */
export function majorGateLogLines(appName: string, blocked: BlockedService[]): string[] {
  const lines: string[] = [];
  for (const entry of blocked) {
    lines.push(
      `[deploy] ${name(entry)} moved from major ${entry.from} to ${entry.to} — the tag names no version, so the pull changed the engine.`,
    );
    lines.push(
      `[deploy] A major ${entry.to} ${entry.engine} exits on its version check against a data directory written by ${entry.from}. The data is not altered by the attempt.`,
    );
    if (entry.plan?.needsIntermediateSteps) {
      lines.push(
        `[deploy] ${entry.engine} cannot cross that in one move — land on ${entry.plan.hops.join(", then ")} in order.`,
      );
    }
  }
  lines.push(
    `[deploy] Stopped before the swap. ${appName} is still serving the old container and nothing was replaced.`,
  );
  lines.push(
    `[deploy] Pin the tag to the major it is running to deploy now, or migrate the data and pin the new one.`,
  );
  return lines;
}

/** The deploy's failure message — the one the notification and the row carry. */
export function majorGateBlockMessage(appName: string, blocked: BlockedService[]): string {
  const moves = blocked
    .map((entry) => `${name(entry)} moved from major ${entry.from} to ${entry.to}`)
    .join("; ");
  const first = blocked[0];
  return (
    `${moves}. Stopped before the swap — ${appName} is still serving and nothing was replaced. ` +
    `A major ${first.to} container exits on its version check against a ${first.from} data directory. ` +
    `Pin the tag to ${first.from} to deploy now, or migrate the data first.`
  );
}
