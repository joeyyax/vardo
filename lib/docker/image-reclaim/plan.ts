// ---------------------------------------------------------------------------
// Building the reclamation plan: which idle apps' images would be removed.
//
// Selection is pure and separated from Docker and the database so a dry run and
// a real run can share it — the run executes exactly the plan it is handed.
// ---------------------------------------------------------------------------

import { isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { isSelfApp } from "../self-env";
import { listImages } from "../client";
import { appImages } from "../image-updates/compose-images";
import { refCacheKey, parseImageRef } from "../image-updates/image-ref";
import {
  classifyImage,
  composeBuilds,
  idleDays,
  imageReclaimable,
  imageSkipReason,
  resolveIdleThreshold,
  type ImageSafety,
  type ReclaimPolicy,
  type SkipReason,
} from "./policy";

/** App row as far as reclamation is concerned. */
export interface PlannableApp {
  id: string;
  name: string;
  displayName: string;
  status: string;
  parked: boolean;
  deployType: string | null;
  imageName: string | null;
  composeContent: string | null;
  composeService: string | null;
  isSystemManaged: boolean;
  imageReclaimPolicy: ReclaimPolicy;
  imageReclaimIdleDays: number | null;
  lastRunningAt: Date | null;
}

export interface PlannedImage {
  image: string;
  safety: ImageSafety;
  /** Bytes Docker reports for this image. Layers are shared, so sums overstate. */
  bytes: number;
  /** False when the image is not present locally — nothing to remove. */
  present: boolean;
}

export interface ReclaimCandidate {
  appId: string;
  appName: string;
  displayName: string;
  idleDays: number;
  thresholdDays: number;
  images: PlannedImage[];
  /** Upper bound: shared layers are counted once per image that references them. */
  estimatedBytes: number;
}

export interface ReclaimSkip {
  appId: string;
  appName: string;
  displayName: string;
  reason: SkipReason;
  /** The image that forced the skip, when one did. */
  image?: string;
  idleDays?: number | null;
}

export interface ReclaimPlan {
  defaultIdleDays: number;
  candidates: ReclaimCandidate[];
  skipped: ReclaimSkip[];
  /** Upper bound across all candidates. Never presented as free space. */
  estimatedBytes: number;
  generatedAt: string;
}

/** Docker image sizes keyed by normalized `registry/repository:tag`. */
export type ImageSizes = Map<string, number>;

export function indexImageSizes(
  images: { repoTags: string[]; size: number }[],
): ImageSizes {
  const sizes: ImageSizes = new Map();
  for (const image of images) {
    for (const tag of image.repoTags) {
      const ref = parseImageRef(tag);
      if (ref) sizes.set(refCacheKey(ref), image.size);
    }
  }
  return sizes;
}

/** Images an app is responsible for, or null when we cannot read its compose. */
function resolveImages(app: PlannableApp): string[] | null {
  if (app.deployType === "image") {
    return app.imageName ? [app.imageName] : [];
  }
  if (!app.composeContent) return null;
  return appImages({
    deployType: app.deployType,
    imageName: app.imageName,
    composeContent: app.composeContent,
    composeService: app.composeService,
  }).map((entry) => entry.image);
}

function skip(app: PlannableApp, reason: SkipReason, extra?: Partial<ReclaimSkip>): ReclaimSkip {
  return {
    appId: app.id,
    appName: app.name,
    displayName: app.displayName,
    reason,
    ...extra,
  };
}

/**
 * Sort apps into what would be reclaimed and what would not, with a reason for
 * every exclusion. Pure — the same input always yields the same plan.
 */
export function selectCandidates(
  rows: PlannableApp[],
  sizes: ImageSizes,
  opts: { defaultIdleDays: number; now: Date },
): ReclaimPlan {
  const candidates: ReclaimCandidate[] = [];
  const skipped: ReclaimSkip[] = [];

  for (const app of rows) {
    if (isSelfApp(app.name)) {
      skipped.push(skip(app, "self"));
      continue;
    }
    if (app.isSystemManaged) {
      skipped.push(skip(app, "system-managed"));
      continue;
    }
    if (app.imageReclaimPolicy === "never") {
      skipped.push(skip(app, "pinned-by-user"));
      continue;
    }
    // Only a cleanly stopped or absent app is a candidate. "error" is left
    // alone — re-pulling under a crash changes what is being debugged.
    if (app.status === "active" || app.status === "deploying") {
      skipped.push(skip(app, "running"));
      continue;
    }
    if (app.status !== "stopped" && app.status !== "missing") {
      skipped.push(skip(app, "error"));
      continue;
    }

    const idle = idleDays(app.lastRunningAt, opts.now);
    if (idle === null) {
      skipped.push(skip(app, "never-run", { idleDays: null }));
      continue;
    }
    // Parking answers the question the threshold is guessing at, so it stands
    // in for the wait. Every guard that decides whether re-pull works still runs.
    const threshold = resolveIdleThreshold(app.imageReclaimIdleDays, opts.defaultIdleDays);
    if (!app.parked && idle < threshold) {
      skipped.push(skip(app, "not-idle", { idleDays: idle }));
      continue;
    }

    // A compose we cannot read is a compose we cannot prove has no `build:`.
    // Git-source apps keep their compose on disk, so this is the common case
    // and refusing is the whole point — encoder and lonvr both build locally.
    if (app.deployType !== "image" && !app.composeContent) {
      skipped.push(skip(app, "compose-unavailable", { idleDays: idle }));
      continue;
    }
    if (app.composeContent && composeBuilds(app.composeContent)) {
      skipped.push(skip(app, "builds-locally", { idleDays: idle }));
      continue;
    }

    const refs = resolveImages(app);
    if (refs === null) {
      skipped.push(skip(app, "compose-unavailable", { idleDays: idle }));
      continue;
    }
    if (refs.length === 0) {
      skipped.push(skip(app, "no-images", { idleDays: idle }));
      continue;
    }

    // Every image must be reclaimable. One unsafe image disqualifies the app —
    // a half-reclaimed stack is not something anyone asked for.
    const planned: PlannedImage[] = [];
    let blocked: ReclaimSkip | null = null;
    for (const image of refs) {
      const ref = parseImageRef(image);
      const safety: ImageSafety = ref ? classifyImage(ref) : "floating";
      if (!imageReclaimable(safety, app.imageReclaimPolicy)) {
        blocked = skip(app, imageSkipReason(safety), { image, idleDays: idle });
        break;
      }
      const key = ref ? refCacheKey(ref) : image;
      const bytes = sizes.get(key);
      planned.push({ image, safety, bytes: bytes ?? 0, present: bytes !== undefined });
    }
    if (blocked) {
      skipped.push(blocked);
      continue;
    }

    const present = planned.filter((p) => p.present);
    if (present.length === 0) {
      skipped.push(skip(app, "no-images", { idleDays: idle }));
      continue;
    }

    candidates.push({
      appId: app.id,
      appName: app.name,
      displayName: app.displayName,
      idleDays: idle,
      thresholdDays: threshold,
      images: planned,
      estimatedBytes: present.reduce((sum, p) => sum + p.bytes, 0),
    });
  }

  return {
    defaultIdleDays: opts.defaultIdleDays,
    candidates,
    skipped,
    estimatedBytes: candidates.reduce((sum, c) => sum + c.estimatedBytes, 0),
    generatedAt: opts.now.toISOString(),
  };
}

/** Load top-level apps and local image sizes, then plan. */
export async function buildReclaimPlan(defaultIdleDays: number, now = new Date()): Promise<ReclaimPlan> {
  const rows = await db.query.apps.findMany({
    where: isNull(apps.parentAppId),
    columns: {
      id: true,
      name: true,
      displayName: true,
      status: true,
      parked: true,
      deployType: true,
      imageName: true,
      composeContent: true,
      composeService: true,
      isSystemManaged: true,
      imageReclaimPolicy: true,
      imageReclaimIdleDays: true,
      lastRunningAt: true,
    },
  });

  const sizes = indexImageSizes(await listImages());
  return selectCandidates(rows as PlannableApp[], sizes, { defaultIdleDays, now });
}
