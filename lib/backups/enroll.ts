// ---------------------------------------------------------------------------
// Backup enrollment (#874)
//
// Enrolling an app classifies each volume (lib/backups/selection.ts), records
// the result as `backup_selection`, and links the app to a job. New apps enroll
// themselves; existing ones are listed for an admin to opt in.
// ---------------------------------------------------------------------------

import { readFile } from "fs/promises";
import { db } from "@/lib/db";
import { apps, backupJobApps, volumes } from "@/lib/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { execFileAsync } from "@/lib/utils/exec";
import { logger } from "@/lib/logger";
import { isVardoManagedApp } from "@/lib/infra/instance-apps";
import { ensureAutoBackupJob, ensureAutoBackupJobOnTarget, resolveBackupTarget } from "./auto-backup";
import { isBackupSelected } from "./durability";
import {
  classifyVolume,
  parseMounts,
  type SelectableVolume,
  type SelectionContext,
  type SelectionDecision,
} from "./selection";

const log = logger.child("backup-enroll");

const HOST_MOUNTS_FILE = "/host-proc/1/mounts";
const MEASURE_TIMEOUT_MS = 30_000;

export type PlannedVolume = SelectableVolume & {
  sizeBytes: number | null | undefined;
  decision: SelectionDecision;
};

/** Host mount table, or empty when Vardo cannot see the host's /proc. */
export async function readHostMounts(): Promise<Map<string, string>> {
  try {
    return parseMounts(await readFile(HOST_MOUNTS_FILE, "utf8"));
  } catch {
    return new Map();
  }
}

/** Every app's bind sources, for the cross-app rules. */
export async function loadBindSources(): Promise<SelectionContext["otherBinds"]> {
  const rows = await db
    .select({ appId: volumes.appId, appName: apps.name, source: volumes.source })
    .from(volumes)
    .innerJoin(apps, eq(apps.id, volumes.appId))
    .where(eq(volumes.type, "bind"));
  return rows.flatMap((r) => (r.appId && r.source ? [{ appId: r.appId, appName: r.appName, source: r.source }] : []));
}

const DOCKER_VOLUME_SOURCE = /^\/var\/lib\/docker\/volumes\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/_data$/;

/** Bytes on disk, or null when it can't be measured. */
export async function measureVolumeBytes(vol: SelectableVolume, appName: string): Promise<number | null> {
  try {
    let mountArg: string;
    if (vol.type === "bind") {
      if (!vol.source?.startsWith("/") || vol.source.includes(":")) return null;
      mountArg = `${vol.source}:/data:ro`;
    } else {
      let dockerName = vol.source?.match(DOCKER_VOLUME_SOURCE)?.[1] ?? null;
      if (!dockerName) {
        const { resolveDockerVolume } = await import("./engine");
        dockerName = await resolveDockerVolume(vol.appId, appName, vol.name, vol.mountPath, () => {});
      }
      if (!dockerName) return null;
      mountArg = `${dockerName}:/data:ro`;
    }
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "-v", mountArg, "alpine", "du", "-sb", "/data"],
      { timeout: MEASURE_TIMEOUT_MS },
    );
    const bytes = parseInt(String(stdout).split("\t")[0], 10);
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Classify an app's volumes. With `measure`, sizes come from disk; without, the
 * volumes are taken as new and empty.
 */
export async function planAppVolumes(
  app: { id: string; name: string },
  opts: {
    measure: boolean;
    volumeIds?: string[];
    hostMounts?: Map<string, string>;
    otherBinds?: SelectionContext["otherBinds"];
  },
): Promise<PlannedVolume[]> {
  const rows = await db.query.volumes.findMany({ where: eq(volumes.appId, app.id) });
  const selected = opts.volumeIds ? rows.filter((r) => opts.volumeIds!.includes(r.id)) : rows;
  if (selected.length === 0) return [];

  const hostMounts = opts.hostMounts ?? (await readHostMounts());
  const otherBinds = opts.otherBinds ?? (await loadBindSources());

  const planned: PlannedVolume[] = [];
  for (const row of selected) {
    const vol = row as SelectableVolume;
    let decision = classifyVolume(vol, { otherBinds, hostMounts });
    let sizeBytes: number | null | undefined;
    // Only a volume that would be included needs its size checked.
    if (opts.measure && decision.verdict === "include" && !row.backupSelection) {
      sizeBytes = await measureVolumeBytes(vol, app.name);
      decision = classifyVolume(vol, { otherBinds, hostMounts, sizeBytes });
    }
    planned.push({ ...vol, sizeBytes, decision });
  }
  return planned;
}

/**
 * Record each planned volume's selection. `include` names the volumes an admin
 * chose; without it, the plan's verdict stands. Volumes already selected keep
 * their selection unless an admin named them.
 */
export async function applySelections(plan: PlannedVolume[], include?: Set<string>): Promise<void> {
  const toInclude: string[] = [];
  const toExclude: string[] = [];
  for (const vol of plan) {
    if (include) {
      (include.has(vol.id) ? toInclude : vol.backupSelection ? [] : toExclude).push(vol.id);
      continue;
    }
    if (vol.backupSelection) continue;
    (vol.decision.verdict === "include" ? toInclude : toExclude).push(vol.id);
  }
  const now = new Date();
  if (toInclude.length) {
    await db.update(volumes).set({ backupSelection: "include", updatedAt: now }).where(inArray(volumes.id, toInclude));
    await renameUnsafe(plan.filter((v) => toInclude.includes(v.id)));
  }
  if (toExclude.length) {
    await db
      .update(volumes)
      .set({ backupSelection: "exclude", updatedAt: now })
      .where(and(inArray(volumes.id, toExclude), isNull(volumes.backupSelection)));
  }
}

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

/**
 * Rows imported before #757 carry the host path as their name, which breaks
 * the archive's storage key and named-volume lookup. Rename them the way new
 * rows are named, from the mount path.
 */
async function renameUnsafe(included: PlannedVolume[]): Promise<void> {
  const unsafe = included.filter((v) => !SAFE_NAME.test(v.name) && v.appId);
  if (unsafe.length === 0) return;
  const siblings = await db.query.volumes.findMany({
    where: eq(volumes.appId, unsafe[0].appId!),
    columns: { name: true },
  });
  const taken = new Set(siblings.map((v) => v.name));
  for (const vol of unsafe) {
    const base = vol.mountPath.replace(/\//g, "-").replace(/^-+/, "").replace(/[^a-zA-Z0-9._-]/g, "-") || "volume";
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
    taken.add(name);
    await db.update(volumes).set({ name }).where(eq(volumes.id, vol.id));
    vol.name = name;
  }
}

export type EnrollResult =
  | { status: "disabled" }
  | { status: "nothing-to-back-up" }
  | { status: "no-target" }
  | { status: "covered"; jobId: string | null };

/**
 * Enroll a newly created, adopted or imported app. Respects the backups flag;
 * with no target the app stays uncovered and raises "No backup job covers
 * this app".
 */
export async function enrollNewApp(opts: {
  appId: string;
  appName: string;
  organizationId: string;
  measure?: boolean;
}): Promise<EnrollResult> {
  if (!(await isFeatureEnabledAsync("backups"))) return { status: "disabled" };

  const plan = await planAppVolumes({ id: opts.appId, name: opts.appName }, { measure: opts.measure ?? false });
  if (!plan.some((v) => v.decision.verdict === "include")) return { status: "nothing-to-back-up" };

  await applySelections(plan);
  const jobId = await ensureAutoBackupJob(opts);
  if (jobId) {
    log.info(`Enrolled ${opts.appName} in backup job ${jobId}`);
    return { status: "covered", jobId };
  }

  return (await resolveBackupTarget(opts.organizationId)) ? { status: "covered", jobId: null } : { status: "no-target" };
}

/**
 * Classify volumes a later deploy found on an app. Only an app already covered
 * by a job takes them in; an uncovered existing app waits for an admin.
 */
export async function enrollNewVolumes(opts: {
  appId: string;
  appName: string;
  volumeIds: string[];
  covered: boolean;
}): Promise<void> {
  if (!opts.covered || opts.volumeIds.length === 0) return;
  if (!(await isFeatureEnabledAsync("backups"))) return;
  const plan = await planAppVolumes(
    { id: opts.appId, name: opts.appName },
    { measure: true, volumeIds: opts.volumeIds },
  );
  await applySelections(plan);
}

/** Admin opt-in: record the chosen volumes and cover the app on a target. */
export async function optInApp(opts: {
  appId: string;
  appName: string;
  organizationId: string;
  targetId: string;
  volumeIds?: string[];
}): Promise<{ jobId: string; included: string[] }> {
  // Without a chosen list, the default is what the uncovered list showed: measured.
  const plan = await planAppVolumes({ id: opts.appId, name: opts.appName }, { measure: !opts.volumeIds });
  const include = new Set(
    opts.volumeIds?.filter((id) => plan.some((v) => v.id === id)) ??
      plan.filter((v) => v.decision.verdict === "include").map((v) => v.id),
  );
  await applySelections(plan, include);
  const jobId = await ensureAutoBackupJobOnTarget(opts);
  return { jobId, included: [...include] };
}

/** enrollNewApp for request paths: a failure is logged, never thrown. */
export async function enrollQuietly(opts: Parameters<typeof enrollNewApp>[0]): Promise<EnrollResult | null> {
  try {
    return await enrollNewApp(opts);
  } catch (err) {
    log.warn(`Backup enrollment for ${opts.appName} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Uncovered apps
// ---------------------------------------------------------------------------

const SIZE_TTL_MS = 10 * 60_000;
const MEASURE_CONCURRENCY = 6;
const sizeCache = new Map<string, { at: number; bytes: number | null }>();

async function cachedSize(vol: SelectableVolume, appName: string): Promise<number | null> {
  const key = `${vol.id}:${vol.source ?? ""}`;
  const hit = sizeCache.get(key);
  if (hit && Date.now() - hit.at < SIZE_TTL_MS) return hit.bytes;
  const bytes = await measureVolumeBytes(vol, appName);
  sizeCache.set(key, { at: Date.now(), bytes });
  return bytes;
}

export type UncoveredApp = {
  id: string;
  name: string;
  displayName: string | null;
  /** "uncovered": no job; "partial": a job that leaves app state out. */
  status: "uncovered" | "partial";
  volumes: {
    id: string;
    name: string;
    mountPath: string;
    type: "named" | "bind";
    source: string | null;
    sizeBytes: number | null;
    verdict: "include" | "exclude" | "opt-in";
    reason: string;
    selected: boolean;
  }[];
};

/** Apps of an org whose app state no job captures, with sizes. */
export async function listUncoveredApps(organizationId: string): Promise<UncoveredApp[]> {
  const orgApps = await db.query.apps.findMany({
    where: and(eq(apps.organizationId, organizationId), isNull(apps.parentAppId)),
    columns: { id: true, name: true, displayName: true, isSystemManaged: true },
  });
  const candidates = orgApps.filter((a) => !isVardoManagedApp(a));
  if (candidates.length === 0) return [];

  const links = await db.query.backupJobApps.findMany({
    where: inArray(
      backupJobApps.appId,
      candidates.map((a) => a.id),
    ),
    with: { backupJob: { columns: { organizationId: true } } },
  });
  const coveredIds = new Set(
    links
      .filter((l) => l.backupJob.organizationId === organizationId || l.backupJob.organizationId === null)
      .map((l) => l.appId),
  );

  const hostMounts = await readHostMounts();
  const otherBinds = await loadBindSources();
  const out: UncoveredApp[] = [];

  const plans = await Promise.all(
    candidates.map(async (app) => ({
      app,
      plan: await planAppVolumes(app, { measure: false, hostMounts, otherBinds }),
    })),
  );

  // Only volumes that could be backed up are measured, a few at a time.
  const sizes = new Map<string, number | null>();
  const queue = plans.flatMap(({ app, plan }) =>
    plan.filter((v) => v.decision.verdict !== "exclude").map((vol) => ({ app, vol })),
  );
  await Promise.all(
    Array.from({ length: MEASURE_CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        sizes.set(next.vol.id, await cachedSize(next.vol, next.app.name));
      }
    }),
  );

  for (const { app, plan } of plans) {
    const rows: UncoveredApp["volumes"] = [];
    for (const vol of plan) {
      const sizeBytes = sizes.has(vol.id) ? sizes.get(vol.id)! : null;
      const decision = sizes.has(vol.id)
        ? classifyVolume(vol, { otherBinds, hostMounts, sizeBytes })
        : vol.decision;
      rows.push({
        id: vol.id,
        name: vol.name,
        mountPath: vol.mountPath,
        type: vol.type,
        source: vol.source,
        sizeBytes,
        verdict: decision.verdict,
        reason: decision.reason,
        selected: isBackupSelected({
          persistent: vol.persistent,
          durability: vol.durability,
          backupSelection: vol.backupSelection,
        }),
      });
    }

    const covered = coveredIds.has(app.id);
    const wanted = rows.filter((r) => r.verdict !== "exclude");
    if (wanted.length === 0) continue;
    if (covered && wanted.every((r) => r.selected || r.verdict !== "include")) continue;
    out.push({
      id: app.id,
      name: app.name,
      displayName: app.displayName,
      status: covered ? "partial" : "uncovered",
      volumes: rows,
    });
  }
  return out;
}
