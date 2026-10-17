// One host reclaim: build cache, dangling images, exited one-off containers, unused tagged images.
// Volumes are never touched. Every removal is unforced, so Docker refuses anything a container still uses.

import { logger } from "@/lib/logger";
import { formatBytes } from "@/lib/metrics/format";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { holdsFence } from "@/lib/worker/fence";
import {
  getBuildCacheUsage,
  imageTaggedAt,
  listAllContainers,
  listImages,
  pruneBuildCache,
  pruneImages,
  removeContainer,
  removeImage,
} from "../client";
import { BUILD_CACHE_MAX_BYTES } from "../constants";
import { isDeployQueueIdleInDb } from "@/lib/deploy/queue";
import { noDeployCanRun } from "@/lib/deploy/waiting";
import { PRUNE_LOCK_KEY } from "../prune-lock";
import { olderThan, selectUnusedImages, staleOneOffs, type ImageSelection } from "./policy";
import { loadProtection } from "./protect";
import { getHostReclaimConfig, recordHostReclaim, type HostReclaimRun, type ReclaimTrigger } from "./state";

const log = logger.child("host-reclaim");

/** Build cache unused this long goes even under the size cap. */
export const BUILD_CACHE_MAX_AGE = "168h";
/** Dangling images younger than this may be layers of a pull in flight. */
export const DANGLING_MIN_AGE = "1h";
/** Exited `compose run` containers older than this go. */
export const ONE_OFF_MIN_AGE_MS = 60 * 60_000;
/** Outlasts a run with hundreds of images to remove. */
const RECLAIM_LOCK_TTL_MS = 15 * 60_000;

export interface ReclaimPreview {
  buildCacheBytes: number;
  unusedImages: number;
  unusedBytes: number;
  kept: ImageSelection["kept"];
}

async function selectImages(now: number, minAgeMs: number): Promise<ImageSelection> {
  const [images, containers, protection] = await Promise.all([listImages(), listAllContainers(), loadProtection()]);
  const selection = selectUnusedImages(images, containers, protection);
  const taggedAt = new Map<string, number | null>();
  for (const c of selection.candidates) taggedAt.set(c.id, await imageTaggedAt(c.id));
  return olderThan(selection, taggedAt, now, minAgeMs);
}

/** What a run would take, without taking it. Image sizes are an upper bound. */
export async function previewHostReclaim(now = Date.now()): Promise<ReclaimPreview> {
  const config = await getHostReclaimConfig();
  const [cache, selection] = await Promise.all([
    getBuildCacheUsage(),
    selectImages(now, config.minImageAgeHours * 3_600_000),
  ]);
  return {
    buildCacheBytes: cache.reclaimable,
    unusedImages: selection.candidates.length,
    unusedBytes: selection.candidates.reduce((sum, c) => sum + c.size, 0),
    kept: selection.kept,
  };
}

/** Untag every tag; the last one frees the layers. False when Docker refused. */
async function removeAllTags(tags: string[]): Promise<boolean> {
  let freed = false;
  for (const tag of tags) {
    const result = await removeImage(tag);
    if (result.deleted.length > 0) freed = true;
  }
  return freed;
}

export async function runHostReclaim(trigger: ReclaimTrigger, now = Date.now()): Promise<HostReclaimRun> {
  const run: HostReclaimRun = {
    trigger,
    startedAt: new Date(now).toISOString(),
    finishedAt: new Date(now).toISOString(),
    buildCacheBytes: 0,
    danglingImages: 0,
    danglingBytes: 0,
    unusedImages: 0,
    unusedBytes: 0,
    containers: 0,
    failures: 0,
  };
  // A busy host isn't recorded, so the next check retries.
  const finish = async (skipped?: string, record = true): Promise<HostReclaimRun> => {
    run.finishedAt = new Date().toISOString();
    if (skipped) run.skipped = skipped;
    if (record) await recordHostReclaim(run).catch((err) => log.warn("Couldn't record the reclaim:", err));
    return run;
  };

  const config = await getHostReclaimConfig();
  if (!config.enabled && trigger !== "manual") return finish("Turned off");
  // Deploys queued behind a missing worker can't start, so they don't hold the host.
  if (!(await isDeployQueueIdleInDb()) && !(await noDeployCanRun())) return finish("Deploys in flight", false);
  const lock = await acquireLock(PRUNE_LOCK_KEY, RECLAIM_LOCK_TTL_MS);
  if (!lock) return finish("Another prune is running", false);

  try {
    try {
      const aged = await pruneBuildCache({ until: [BUILD_CACHE_MAX_AGE] });
      const capped = await pruneBuildCache(undefined, { keepStorage: BUILD_CACHE_MAX_BYTES });
      run.buildCacheBytes = aged.spaceReclaimed + capped.spaceReclaimed;
    } catch (err) {
      run.failures++;
      log.warn("Build cache prune failed:", err);
    }

    try {
      const dangling = await pruneImages({ dangling: ["true"], until: [DANGLING_MIN_AGE] });
      run.danglingImages = dangling.count;
      run.danglingBytes = dangling.spaceReclaimed;
    } catch (err) {
      run.failures++;
      log.warn("Dangling image prune failed:", err);
    }

    for (const id of staleOneOffs(await listAllContainers(), now, ONE_OFF_MIN_AGE_MS)) {
      if (!(await holdsFence())) return await finish("Lost the lease");
      try {
        await removeContainer(id, { volumes: true });
        run.containers++;
      } catch {
        run.failures++;
      }
    }

    const selection = await selectImages(now, config.minImageAgeHours * 3_600_000);
    for (const image of selection.candidates) {
      if (!(await holdsFence())) return await finish("Lost the lease");
      try {
        if (await removeAllTags(image.tags)) {
          run.unusedImages++;
          run.unusedBytes += image.size;
        }
      } catch {
        // 409: a container started using it since the listing.
        run.failures++;
      }
    }
  } finally {
    await releaseLock(PRUNE_LOCK_KEY, lock).catch(() => {});
  }

  const done = await finish();
  log.info(
    `Reclaim (${trigger}): build cache ${formatBytes(done.buildCacheBytes)}, ` +
      `${done.danglingImages} dangling image(s) ${formatBytes(done.danglingBytes)}, ` +
      `${done.unusedImages} unused image(s) up to ${formatBytes(done.unusedBytes)}, ` +
      `${done.containers} one-off container(s); ${done.failures} failure(s)`,
  );
  return done;
}
