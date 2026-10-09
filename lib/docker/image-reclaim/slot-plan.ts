// Builds the slot reclamation plan: which superseded generations would go. Selection is pure.

import { readdir } from "fs/promises";
import { isNull } from "drizzle-orm";
import { join } from "path";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { PROJECTS_DIR } from "@/lib/paths";
import { listAllContainers, listImages, type ImageInfo } from "../client";
import { readCurrentSlot } from "../standby-slot";
import type { Slot } from "../slots";
import {
  buildSlotIndex,
  classifyProject,
  decideSlotImage,
  slotImageRef,
  type SlotApp,
  type SlotEnvironment,
  type SlotGeneration,
  type SlotSkipReason,
  type SlotWarningReason,
  SLOT_WARNING_COPY,
} from "./slot-policy";

const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";

export interface PlannedSlotImage {
  image: string;
  service: string;
  /** Bytes Docker reports for this image. Layers are shared, so sums overstate. */
  bytes: number;
  /** Always true — a planned image was read out of the local image list. */
  present: boolean;
}

export interface SlotReclaimCandidate {
  /** Compose project, which is the generation. */
  project: string;
  /** Owning app, or the project itself when nothing accounts for it. */
  appName: string;
  generation: SlotGeneration;
  images: PlannedSlotImage[];
  /** Upper bound: shared layers are counted once per image that references them. */
  estimatedBytes: number;
  /** Set when this generation is a standby; taking it turns instant rollback into a rebuild. Advisory. */
  rollbackTargetFor?: { appName: string; envName: string; liveSlot: Slot };
  /** Set with `rollbackTargetFor`. Shown next to the row. */
  warning?: { reason: SlotWarningReason; explanation: string };
}

export interface SlotReclaimSkip {
  project: string;
  image: string;
  reason: SlotSkipReason;
  bytes: number;
}

export interface SlotReclaimPlan {
  candidates: SlotReclaimCandidate[];
  skipped: SlotReclaimSkip[];
  /** Upper bound across all candidates. Never presented as free space. */
  estimatedBytes: number;
  generatedAt: string;
}

export interface SlotPlanInput {
  images: ImageInfo[];
  environments: SlotEnvironment[];
  apps: SlotApp[];
  /** Compose projects with at least one container, stopped ones included. */
  projectsWithContainers: Set<string>;
  now: Date;
}

/** Sort locally built slot images into removable and skipped. Pure; non-compose images are omitted. */
export function selectSlotCandidates(input: SlotPlanInput): SlotReclaimPlan {
  const index = buildSlotIndex(input.environments);
  const appsByName = new Map(input.apps.map((a) => [a.name, a]));
  const currentByEnv = new Map(
    input.environments.map((e) => [`${e.appName}-${e.envName}`, e.currentSlot]),
  );

  const byProject = new Map<string, SlotReclaimCandidate>();
  const skipped: SlotReclaimSkip[] = [];

  for (const image of input.images) {
    const project = image.labels[COMPOSE_PROJECT_LABEL];
    const service = image.labels[COMPOSE_SERVICE_LABEL];
    if (!project || !service) continue;

    const ref = slotImageRef(image.repoTags);
    if (!ref.take) {
      skipped.push({ project, image: image.repoTags[0] ?? image.id, reason: ref.reason, bytes: image.size });
      continue;
    }

    const generation = classifyProject(project, index);
    if (!generation) {
      skipped.push({ project, image: ref.ref, reason: "unknown-project", bytes: image.size });
      continue;
    }

    const verdict = decideSlotImage({
      generation,
      currentSlot:
        generation.kind === "slot"
          ? currentByEnv.get(`${generation.appName}-${generation.envName}`) ?? null
          : null,
      projectHasContainers: input.projectsWithContainers.has(project),
      app: appsByName.get(generation.appName ?? "") ?? null,
    });

    if (!verdict.take) {
      skipped.push({ project, image: ref.ref, reason: verdict.reason, bytes: image.size });
      continue;
    }

    let candidate = byProject.get(project);
    if (!candidate) {
      // Any slot generation reaching here is the standby.
      const liveSlot =
        generation.kind === "slot"
          ? currentByEnv.get(`${generation.appName}-${generation.envName}`) ?? null
          : null;
      candidate = {
        project,
        appName: generation.appName ?? project,
        generation,
        images: [],
        estimatedBytes: 0,
        ...(generation.kind === "slot" && liveSlot
          ? {
              rollbackTargetFor: {
                appName: generation.appName,
                envName: generation.envName,
                liveSlot,
              },
              warning: {
                reason: "rollback-target" as const,
                explanation: SLOT_WARNING_COPY["rollback-target"](generation.appName),
              },
            }
          : {}),
      };
      byProject.set(project, candidate);
    }
    candidate.images.push({ image: ref.ref, service, bytes: image.size, present: true });
    candidate.estimatedBytes += image.size;
  }

  // Dead images first, rollback targets after; largest first within each group.
  const candidates = [...byProject.values()].sort(
    (a, b) =>
      Number(Boolean(a.warning)) - Number(Boolean(b.warning)) || b.estimatedBytes - a.estimatedBytes,
  );
  for (const candidate of candidates) {
    candidate.images.sort((a, b) => a.image.localeCompare(b.image));
  }
  skipped.sort((a, b) => a.image.localeCompare(b.image));

  return {
    candidates,
    skipped,
    estimatedBytes: candidates.reduce((sum, c) => sum + c.estimatedBytes, 0),
    generatedAt: input.now.toISOString(),
  };
}

/** The plan minus rollback targets, for sweeps no one reviews. */
export function withoutRollbackTargets(plan: SlotReclaimPlan): SlotReclaimPlan {
  const candidates = plan.candidates.filter((c) => !c.rollbackTargetFor);
  return {
    ...plan,
    candidates,
    estimatedBytes: candidates.reduce((sum, c) => sum + c.estimatedBytes, 0),
  };
}

/** Every environment directory with blue-green slots and its `current` slot. Unreadable symlinks stay, as null. */
export async function readSlotEnvironments(): Promise<SlotEnvironment[]> {
  let appDirs: string[];
  try {
    appDirs = (await readdir(PROJECTS_DIR, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const environments: SlotEnvironment[] = [];
  for (const appName of appDirs) {
    let envDirs: string[];
    try {
      envDirs = (await readdir(join(PROJECTS_DIR, appName), { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }

    for (const envName of envDirs) {
      const envDir = join(PROJECTS_DIR, appName, envName);
      let entries: string[];
      try {
        entries = await readdir(envDir);
      } catch {
        continue;
      }
      if (!entries.includes("blue") && !entries.includes("green")) continue;

      environments.push({
        appName,
        envName,
        currentSlot: await readCurrentSlot(envDir),
      });
    }
  }
  return environments;
}

/** Compose projects with at least one container, stopped ones included. */
export async function projectsWithContainers(): Promise<Set<string>> {
  const containers = await listAllContainers();
  const projects = new Set<string>();
  for (const container of containers) {
    const project = container.labels?.[COMPOSE_PROJECT_LABEL];
    if (project) projects.add(project);
  }
  return projects;
}

/** Load images, containers, slot directories and app policies, then plan. */
export async function buildSlotReclaimPlan(now = new Date()): Promise<SlotReclaimPlan> {
  const rows = await db.query.apps.findMany({
    where: isNull(apps.parentAppId),
    columns: { name: true, isSystemManaged: true, imageReclaimPolicy: true },
  });

  const [images, environments, withContainers] = await Promise.all([
    listImages(),
    readSlotEnvironments(),
    projectsWithContainers(),
  ]);

  return selectSlotCandidates({
    images,
    environments,
    apps: rows.map((r) => ({
      name: r.name,
      isSystemManaged: r.isSystemManaged,
      policy: r.imageReclaimPolicy,
    })) as SlotApp[],
    projectsWithContainers: withContainers,
    now,
  });
}
