// ---------------------------------------------------------------------------
// Executing a reclamation plan.
//
// The only Docker call is removeImage. Volumes are never named here, never
// listed and never removed. Removal is unforced: an image a stopped container
// still references returns 409 and is reported as skipped, because forcing it
// only untags the image, frees nothing, and leaves the container unable to start.
// ---------------------------------------------------------------------------

import { removeImage } from "../client";
import { logger } from "@/lib/logger";
import type { ReclaimPlan } from "./plan";

const log = logger.child("image-reclaim");

export interface ReclaimedImage {
  appName: string;
  image: string;
  /** Bytes Docker reported for the image before removal. Upper bound. */
  bytes: number;
  /** False when Docker only untagged it, so no layers were freed. */
  freedLayers: boolean;
}

export interface FailedImage {
  appName: string;
  image: string;
  error: string;
}

export interface ReclaimResult {
  dryRun: boolean;
  reclaimed: ReclaimedImage[];
  failed: FailedImage[];
  /** Sum over images whose layers were actually freed. Still an upper bound. */
  estimatedBytesFreed: number;
  appsAffected: number;
  finishedAt: string;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Docker returns 409 when a container — including a stopped one — still
  // references the image.
  if (/409|conflict|being used/i.test(message)) {
    return "Still referenced by a container";
  }
  return message;
}

/**
 * Run a plan. A dry run reports exactly what a real run would remove, taking
 * the same branches over the same plan, and issues no Docker calls.
 */
export async function executeReclaimPlan(
  plan: ReclaimPlan,
  opts: { dryRun: boolean },
): Promise<ReclaimResult> {
  const reclaimed: ReclaimedImage[] = [];
  const failed: FailedImage[] = [];
  const appsAffected = new Set<string>();

  for (const candidate of plan.candidates) {
    for (const image of candidate.images) {
      if (!image.present) continue;

      if (opts.dryRun) {
        reclaimed.push({
          appName: candidate.appName,
          image: image.image,
          bytes: image.bytes,
          freedLayers: true,
        });
        appsAffected.add(candidate.appName);
        continue;
      }

      try {
        const result = await removeImage(image.image);
        reclaimed.push({
          appName: candidate.appName,
          image: image.image,
          bytes: image.bytes,
          freedLayers: result.deleted.length > 0,
        });
        appsAffected.add(candidate.appName);
      } catch (err) {
        failed.push({
          appName: candidate.appName,
          image: image.image,
          error: errorMessage(err),
        });
      }
    }
  }

  const estimatedBytesFreed = reclaimed
    .filter((r) => r.freedLayers)
    .reduce((sum, r) => sum + r.bytes, 0);

  if (!opts.dryRun && reclaimed.length > 0) {
    log.info(
      `Reclaimed ${reclaimed.length} image(s) across ${appsAffected.size} idle app(s)`,
    );
  }
  if (failed.length > 0) {
    log.info(`${failed.length} image(s) could not be removed`);
  }

  return {
    dryRun: opts.dryRun,
    reclaimed,
    failed,
    estimatedBytesFreed,
    appsAffected: appsAffected.size,
    finishedAt: new Date().toISOString(),
  };
}
