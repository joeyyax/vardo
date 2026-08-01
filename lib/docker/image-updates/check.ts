import { lt, inArray } from "drizzle-orm";
import pLimit from "p-limit";
import { db } from "@/lib/db";
import { apps, imageUpdateChecks } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { inspectImageDigest } from "@/lib/docker/client";
import { appImages, type ServiceImage } from "./compose-images";
import { isMutableShortForm, refCacheKey, type ImageRef } from "./image-ref";
import { fetchRemoteDigest, fetchTags, RateLimitedError } from "./registry";
import { parseTag, selectUpdateCandidate, type BumpSeverity } from "./tag-version";

/**
 * Update checking, budgeted.
 *
 * Docker Hub allows 100 anonymous manifest requests per 6 hours per IP, and
 * exhausting it blocks deploys. Every registry call is therefore cached for
 * `CHECK_TTL_MS`, capped per sweep, run two at a time, and stopped entirely by
 * a cooldown once a 429 comes back.
 */

const CHECK_TTL_MS = 6 * 60 * 60 * 1000;
const SWEEP_BATCH_SIZE = 12;
const CONCURRENCY = 2;
const STAGGER_MS = 300;
const COOLDOWN_KEY = "image_check_cooldown_until";
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type CheckStatus = "current" | "update" | "drift" | "unknown";

export interface ImageCheckResult {
  imageRef: string;
  status: CheckStatus;
  currentTag: string;
  latestTag: string | null;
  severity: BumpSeverity | null;
  /** Digest the tag resolved to, on the floating-tag path only. */
  remoteDigest: string | null;
  unorderable: string[];
  error: string | null;
  checkedAt: Date;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bare `sha256:...` from either a plain digest or a `repo@sha256:...` ref. */
function normalizeDigest(value: string | null): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  return at === -1 ? value : value.slice(at + 1);
}

export async function getCooldownUntil(): Promise<number> {
  const raw = await getSystemSettingRaw(COOLDOWN_KEY);
  const value = raw ? Number(raw) : 0;
  return Number.isFinite(value) ? value : 0;
}

async function startCooldown(retryAfterMs: number | null) {
  const until = Date.now() + (retryAfterMs ?? DEFAULT_COOLDOWN_MS);
  await setSystemSetting(COOLDOWN_KEY, String(until));
  logger.warn(
    `Registry rate limit hit — update checks paused until ${new Date(until).toISOString()}`,
  );
}

/**
 * Checks one image. Callers must hold the budget: this always talks to the
 * registry.
 */
export async function checkImage(
  ref: ImageRef,
  localImage: string,
): Promise<ImageCheckResult> {
  const imageRef = refCacheKey(ref);
  const base: ImageCheckResult = {
    imageRef,
    status: "unknown",
    currentTag: ref.tag,
    latestTag: null,
    severity: null,
    remoteDigest: null,
    unorderable: [],
    error: null,
    checkedAt: new Date(),
  };

  const parsed = parseTag(ref.tag);
  const needsDigestCheck = parsed.kind === "floating" || isMutableShortForm(ref, ref.tag);

  if (needsDigestCheck) {
    const remote = normalizeDigest(await fetchRemoteDigest(ref, ref.tag));
    if (!remote) return { ...base, error: "Tag not found in registry" };
    const local = normalizeDigest(await inspectImageDigest(localImage));
    if (!local) return { ...base, remoteDigest: remote, error: "No local digest to compare" };
    return { ...base, remoteDigest: remote, status: local === remote ? "current" : "drift" };
  }

  if (parsed.kind === "opaque") {
    return { ...base, error: `Unrecognized tag scheme: ${ref.tag}` };
  }

  const tags = await fetchTags(ref);
  if (tags.length === 0) return { ...base, error: "Registry returned no tags" };

  const candidate = selectUpdateCandidate(ref.tag, tags);
  return {
    ...base,
    status: candidate.latest ? "update" : "current",
    latestTag: candidate.latest,
    severity: candidate.latest ? candidate.severity : null,
    unorderable: candidate.unorderable.slice(0, 10),
  };
}

async function persist(result: ImageCheckResult) {
  await db
    .insert(imageUpdateChecks)
    .values({
      imageRef: result.imageRef,
      status: result.status,
      latestTag: result.latestTag,
      severity: result.severity,
      remoteDigest: result.remoteDigest,
      unorderable: result.unorderable,
      error: result.error,
      checkedAt: result.checkedAt,
    })
    .onConflictDoUpdate({
      target: imageUpdateChecks.imageRef,
      set: {
        status: result.status,
        latestTag: result.latestTag,
        severity: result.severity,
        remoteDigest: result.remoteDigest,
        unorderable: result.unorderable,
        error: result.error,
        checkedAt: result.checkedAt,
      },
    });
}

/** Cached rows for the given refs, whatever their age. */
export async function readCachedChecks(
  imageRefs: string[],
): Promise<Map<string, typeof imageUpdateChecks.$inferSelect>> {
  if (imageRefs.length === 0) return new Map();
  const rows = await db
    .select()
    .from(imageUpdateChecks)
    .where(inArray(imageUpdateChecks.imageRef, imageRefs));
  return new Map(rows.map((row) => [row.imageRef, row]));
}

interface SweepTarget {
  ref: ImageRef;
  localImage: string;
}

/**
 * Refreshes stale entries, oldest first, up to `limit`.
 *
 * Returns the number checked. A rate limit stops the sweep immediately and
 * leaves the remaining entries stale rather than retrying into the wall.
 */
export async function refreshStaleChecks(limit = SWEEP_BATCH_SIZE): Promise<number> {
  const cooldownUntil = await getCooldownUntil();
  if (Date.now() < cooldownUntil) return 0;

  const targets = await collectSweepTargets();
  if (targets.length === 0) return 0;

  const cached = await readCachedChecks(targets.map((t) => refCacheKey(t.ref)));
  const cutoff = Date.now() - CHECK_TTL_MS;
  const stale = targets
    .filter((target) => {
      const row = cached.get(refCacheKey(target.ref));
      return !row || row.checkedAt.getTime() < cutoff;
    })
    .sort((a, b) => {
      const aAt = cached.get(refCacheKey(a.ref))?.checkedAt.getTime() ?? 0;
      const bAt = cached.get(refCacheKey(b.ref))?.checkedAt.getTime() ?? 0;
      return aAt - bAt;
    })
    .slice(0, limit);

  if (stale.length === 0) return 0;

  const gate = pLimit(CONCURRENCY);
  let halted = false;
  let checked = 0;

  await Promise.all(
    stale.map((target, index) =>
      gate(async () => {
        if (halted) return;
        await sleep(index * STAGGER_MS);
        try {
          const result = await checkImage(target.ref, target.localImage);
          await persist(result);
          checked++;
        } catch (error) {
          if (error instanceof RateLimitedError) {
            halted = true;
            await startCooldown(error.retryAfterMs);
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          await persist({
            imageRef: refCacheKey(target.ref),
            status: "unknown",
            currentTag: target.ref.tag,
            latestTag: null,
            severity: null,
            remoteDigest: null,
            unorderable: [],
            error: message,
            checkedAt: new Date(),
          });
          checked++;
        }
      }),
    ),
  );

  return checked;
}

/** One entry per distinct image across every app, deduped by cache key. */
async function collectSweepTargets(): Promise<SweepTarget[]> {
  const rows = await db
    .select({
      deployType: apps.deployType,
      imageName: apps.imageName,
      composeContent: apps.composeContent,
      composeService: apps.composeService,
      parentAppId: apps.parentAppId,
    })
    .from(apps);

  const byKey = new Map<string, SweepTarget>();
  for (const row of rows) {
    // Child services duplicate the parent's compose; count each image once.
    if (row.parentAppId) continue;
    for (const entry of appImages(row)) {
      const key = refCacheKey(entry.ref);
      if (!byKey.has(key)) byKey.set(key, { ref: entry.ref, localImage: entry.image });
    }
  }
  return [...byKey.values()];
}

/** Prunes rows for images no longer referenced by any app. */
export async function pruneOrphanedChecks(): Promise<number> {
  const targets = await collectSweepTargets();
  const live = new Set(targets.map((t) => refCacheKey(t.ref)));
  const rows = await db.select({ imageRef: imageUpdateChecks.imageRef }).from(imageUpdateChecks);
  const dead = rows.map((r) => r.imageRef).filter((ref) => !live.has(ref));
  if (dead.length === 0) return 0;
  await db.delete(imageUpdateChecks).where(inArray(imageUpdateChecks.imageRef, dead));
  return dead.length;
}

/** Drops entries older than a week so a removed image cannot linger. */
export async function pruneExpiredChecks(): Promise<void> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await db.delete(imageUpdateChecks).where(lt(imageUpdateChecks.checkedAt, cutoff));
}

export type { ServiceImage };
export { CHECK_TTL_MS, SWEEP_BATCH_SIZE };
