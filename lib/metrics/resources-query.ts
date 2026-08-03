// ---------------------------------------------------------------------------
// Fetching resource snapshots for an organization.
//
// One pass serves every app and every project on a page: the time series are
// read once, the scoping is done in memory, and the same builder produces both
// levels so an app row and its project card can never disagree.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, projects, volumeLimits } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { isMetricsEnabled } from "./config";
import { RESOURCE_METRICS, readSeries, type SeriesByMetric } from "./resource-samples";
import { appResourceScope, projectResourceScope, type ScopedApp } from "./resource-scope";
import { buildSnapshot, NO_LIMITS, type AppLimits, type HostCapacity } from "./resources";
import type { ResourceSnapshot } from "./resource-types";

const log = logger.child("resources");

/** Sparkline window and resolution. 24 buckets is what a row-sized chart shows. */
export const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
export const DEFAULT_BUCKETS = 24;

export type OrgResources = {
  /** Snapshot per app id, compose children included. */
  apps: Record<string, ResourceSnapshot>;
  /** Snapshot per project id, built from top-level apps only. */
  projects: Record<string, ResourceSnapshot>;
  host: HostCapacity;
  /** False when no metrics provider is configured — every reading is absent. */
  collecting: boolean;
};

type AppRow = {
  id: string;
  name: string;
  projectId: string;
  parentAppId: string | null;
  composeService: string | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
  gpuEnabled: boolean;
  parentApp: { name: string } | null;
};

/** Docker's view of the host, best-effort — a missing answer becomes "unknown". */
async function readHostCapacity(): Promise<HostCapacity> {
  try {
    const { getSystemInfo } = await import("@/lib/docker/client");
    const info = await getSystemInfo();
    return {
      cpuCores: info.cpus > 0 ? info.cpus : null,
      memoryBytes: info.memoryTotal > 0 ? info.memoryTotal : null,
    };
  } catch (err) {
    log.warn("Host capacity unavailable:", (err as Error).message);
    return { cpuCores: null, memoryBytes: null };
  }
}

function limitsOf(app: AppRow, diskLimitBytes: number | null): AppLimits {
  return {
    cpuLimit: app.cpuLimit,
    memoryLimitMb: app.memoryLimit,
    diskLimitBytes,
    gpuEnabled: app.gpuEnabled,
  };
}

function scopedApp(app: AppRow): ScopedApp {
  return {
    id: app.id,
    name: app.name,
    parentAppId: app.parentAppId,
    composeService: app.composeService,
    parentApp: app.parentApp,
  };
}

/**
 * Usage and limits for every app and project in an organization.
 *
 * A project's readings come from its top-level apps' scopes. Compose children
 * store under their parent's `project` label, so they are already inside that
 * total — adding their own scope would count every stack service twice.
 */
export async function getOrgResources(
  orgId: string,
  options: { windowMs?: number; buckets?: number; now?: number } = {},
): Promise<OrgResources> {
  const now = options.now ?? Date.now();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const buckets = options.buckets ?? DEFAULT_BUCKETS;

  const [appRows, projectRows, limitRows] = await Promise.all([
    db.query.apps.findMany({
      where: eq(apps.organizationId, orgId),
      columns: {
        id: true,
        name: true,
        projectId: true,
        parentAppId: true,
        composeService: true,
        cpuLimit: true,
        memoryLimit: true,
        gpuEnabled: true,
      },
      with: { parentApp: { columns: { name: true } } },
    }),
    db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: { id: true, name: true },
    }),
    db.select({ appId: volumeLimits.appId, maxSizeBytes: volumeLimits.maxSizeBytes }).from(volumeLimits),
  ]);

  const collecting = isMetricsEnabled();
  const [host, series] = await Promise.all([
    readHostCapacity(),
    collecting
      ? readSeries(RESOURCE_METRICS, now - windowMs, now, Math.floor(windowMs / buckets))
      : Promise.resolve(new Map() as SeriesByMetric),
  ]);

  const rows = appRows as AppRow[];
  const diskLimitByApp = new Map(limitRows.map((r) => [r.appId, r.maxSizeBytes]));
  const knownAppNames = new Set(rows.filter((a) => !a.parentAppId).map((a) => a.name));

  const appSnapshots: Record<string, ResourceSnapshot> = {};
  for (const app of rows) {
    appSnapshots[app.id] = buildSnapshot({
      subject: { type: "app", id: app.id, name: app.name },
      scope: appResourceScope(scopedApp(app), knownAppNames),
      series,
      limits: [limitsOf(app, diskLimitByApp.get(app.id) ?? null)],
      host,
      // /system/df attributes disk by the vardo.project label, which names the
      // top-level app — a stack child has no figure of its own to report.
      diskSupported: !app.parentAppId,
      now,
    });
  }

  const projectSnapshots: Record<string, ResourceSnapshot> = {};
  for (const project of projectRows) {
    const members = rows.filter((a) => a.projectId === project.id);
    const topLevel = members.filter((a) => !a.parentAppId);
    projectSnapshots[project.id] = buildSnapshot({
      subject: { type: "project", id: project.id, name: project.name },
      scope: projectResourceScope(topLevel.map(scopedApp), knownAppNames),
      series,
      limits: topLevel.map((a) => limitsOf(a, diskLimitByApp.get(a.id) ?? null)),
      host,
      diskSupported: topLevel.length > 0,
      now,
    });
  }

  return { apps: appSnapshots, projects: projectSnapshots, host, collecting };
}

/** One app's snapshot. Prefer getOrgResources when a page needs more than one. */
export async function getAppResources(
  orgId: string,
  appId: string,
  options?: { windowMs?: number; buckets?: number; now?: number },
): Promise<ResourceSnapshot | null> {
  const all = await getOrgResources(orgId, options);
  return all.apps[appId] ?? null;
}

/** One project's snapshot. */
export async function getProjectResources(
  orgId: string,
  projectId: string,
  options?: { windowMs?: number; buckets?: number; now?: number },
): Promise<ResourceSnapshot | null> {
  const all = await getOrgResources(orgId, options);
  return all.projects[projectId] ?? null;
}

/** An all-absent snapshot, for a subject with no metrics at all. */
export function emptySnapshot(subject: ResourceSnapshot["subject"]): ResourceSnapshot {
  return buildSnapshot({
    subject,
    scope: { appNames: [], service: null },
    series: new Map(),
    limits: [NO_LIMITS],
    host: { cpuCores: null, memoryBytes: null },
    diskSupported: false,
    now: Date.now(),
  });
}
