// ---------------------------------------------------------------------------
// Reading engine majors around the pre-pull.
//
// Both reads are `docker inspect` against the local daemon — the "before" image
// is the one the app is running, and the "after" image is what the pull just
// wrote over the same tag. No registry config blob is fetched.
// ---------------------------------------------------------------------------

import { extractImageMajor, type ImageMajor } from "../image-updates/image-major";
import {
  blockedService,
  majorGateBlockMessage,
  majorGateCandidates,
  majorGateLogLines,
  majorGateVerdict,
  type MajorGateCandidate,
  type MajorGateVerdict,
} from "../image-updates/major-gate";
import { DeployBlockedError } from "../errors";
import type { DeployContext } from "../deploy-context";

/** Stable key for a candidate — two services can share one image. */
export function candidateKey(candidate: { service: string | null; image: string }): string {
  return `${candidate.service ?? ""}\u0000${candidate.image}`;
}

export type MajorReads = Map<string, ImageMajor | null>;

/** Majors of the images currently on this host, read before anything is pulled. */
export async function readMajors(candidates: MajorGateCandidate[]): Promise<MajorReads> {
  const { inspectImageMeta } = await import("../client");
  const reads: MajorReads = new Map();
  for (const candidate of candidates) {
    const meta = await inspectImageMeta(candidate.image);
    reads.set(
      candidateKey(candidate),
      meta ? extractImageMajor(candidate.image, { env: meta.env, labels: meta.labels }) : null,
    );
  }
  return reads;
}

/**
 * A recorded major stands in when the old image is no longer on this host —
 * a prune between deploys otherwise turns every gate into "cannot say".
 */
export function withRecordedBaseline(
  candidates: MajorGateCandidate[],
  reads: MajorReads,
  recorded: Record<string, number> | undefined,
): MajorReads {
  if (!recorded) return reads;
  const merged: MajorReads = new Map(reads);
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    if (merged.get(key)) continue;
    const major = recorded[candidate.service ?? ""];
    if (typeof major === "number") {
      merged.set(key, { major, source: "env", raw: String(major) });
    }
  }
  return merged;
}

/** Verdict per candidate, comparing the majors on either side of the pull. */
export function compareMajors(
  candidates: MajorGateCandidate[],
  before: MajorReads,
  after: MajorReads,
): MajorGateVerdict[] {
  return candidates.map((candidate) => {
    const key = candidateKey(candidate);
    return majorGateVerdict(candidate, before.get(key) ?? null, after.get(key) ?? null);
  });
}

/** Services the pull can move, paired with the image the compose pins. */
export function gateCandidates(ctx: DeployContext, pullServices: string[]): MajorGateCandidate[] {
  const singleImage = ctx.app.deployType === "image";
  return majorGateCandidates(
    pullServices.map((name) => ({
      service: singleImage ? null : name,
      image: ctx.compose.services[name]?.image,
    })),
  );
}

/**
 * The major each major-locked service just deployed on, for the snapshot. Read
 * after the swap, so it records what is actually serving.
 */
export async function observedMajors(ctx: DeployContext): Promise<Record<string, number>> {
  const candidates = gateCandidates(ctx, Object.keys(ctx.compose.services));
  if (candidates.length === 0) return {};

  const reads = await readMajors(candidates);
  const observed: Record<string, number> = {};
  for (const candidate of candidates) {
    const read = reads.get(candidateKey(candidate));
    if (read) observed[candidate.service ?? ""] = read.major;
  }
  return observed;
}

export interface MajorGateState {
  candidates: MajorGateCandidate[];
  before: MajorReads;
}

/** Majors on this host before the pull, taken while the old slot is serving. */
export async function majorGateBefore(
  ctx: DeployContext,
  pullServices: string[],
): Promise<MajorGateState> {
  const candidates = gateCandidates(ctx, pullServices);
  if (candidates.length === 0) return { candidates, before: new Map() };

  const reads = await readMajors(candidates);
  return { candidates, before: withRecordedBaseline(candidates, reads, await lastMajors(ctx)) };
}

/** What the last successful deploy of this app ran, keyed by compose service. */
async function lastMajors(ctx: DeployContext): Promise<Record<string, number> | undefined> {
  try {
    const { db } = await import("@/lib/db");
    const { deployments } = await import("@/lib/db/schema");
    const { and, desc, eq } = await import("drizzle-orm");
    const previous = await db.query.deployments.findFirst({
      where: and(eq(deployments.appId, ctx.appId), eq(deployments.status, "success")),
      orderBy: desc(deployments.finishedAt),
      columns: { configSnapshot: true },
    });
    return previous?.configSnapshot?.imageMajors;
  } catch {
    return undefined;
  }
}

/**
 * Stops the deploy when the pull crossed a major.
 *
 * Called after the pre-pull and before the old slot is touched: the images are
 * local, nothing serving has been replaced, and throwing here leaves the app
 * exactly as it was.
 */
export async function majorGateAfter(ctx: DeployContext, state: MajorGateState): Promise<void> {
  if (state.candidates.length === 0) return;

  const after = await readMajors(state.candidates);
  const verdicts = compareMajors(state.candidates, state.before, after);

  for (const verdict of verdicts) {
    if (verdict.kind === "unknown") {
      ctx.log(
        `[deploy] Could not check the engine major for ${verdict.candidate.image} — ${verdict.reason}. Deploying anyway.`,
      );
    }
  }

  const blocked = verdicts
    .filter((v): v is Extract<MajorGateVerdict, { kind: "changed" }> => v.kind === "changed")
    .map(blockedService);
  if (blocked.length === 0) return;

  const appName = ctx.app.displayName || ctx.app.name;
  for (const line of majorGateLogLines(appName, blocked)) ctx.log(line);

  const { writeMajorGateBlock } = await import("../image-updates/major-gate-store");
  await writeMajorGateBlock({
    appId: ctx.appId,
    appName,
    deploymentId: ctx.deploymentId,
    blockedAt: new Date().toISOString(),
    services: blocked,
  });

  throw new DeployBlockedError(majorGateBlockMessage(appName, blocked));
}
