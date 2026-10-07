// Executes a reclamation plan. The only Docker call is removeImage; volumes are never touched.
// Removal is unforced: forcing an image a stopped container references frees nothing and breaks the container.

import { removeImage } from "../client";
import { logger } from "@/lib/logger";

const log = logger.child("image-reclaim");

/** The minimum a plan must expose to be executed. */
export interface ExecutablePlan {
  candidates: {
    appName: string;
    images: { image: string; bytes: number; present: boolean }[];
  }[];
}

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
  /** Sum over images whose layers were freed. Upper bound. */
  estimatedBytesFreed: number;
  appsAffected: number;
  finishedAt: string;
}

function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // 409: a container (even a stopped one) still references the image.
  if (/409|conflict|being used/i.test(message)) {
    return "Still referenced by a container";
  }
  return message;
}

/** Run a plan. A dry run reports what a real run would remove and makes no Docker calls. */
export async function executeReclaimPlan(
  plan: ExecutablePlan,
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
