// Auto-created system backup target, Vardo's own database job and per-app daily jobs.

import { db } from "@/lib/db";
import { backupTargets, backupJobs, backupJobApps, backupJobVolumes, volumes } from "@/lib/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash } from "crypto";
import { getBackupStorageConfig } from "@/lib/system-settings";
import { assertSafeName } from "@/lib/docker/validate";
import { logger } from "@/lib/logger";
import { isBackupSelected } from "./durability";
import { sealTargetConfig } from "./target-config";

const log = logger.child("auto-backup");

/** Return the system-level backup target, creating it from configured storage if missing. Null when none. */
export async function ensureHostBackupTarget() {
  const existing = await db.query.backupTargets.findFirst({
    where: isNull(backupTargets.organizationId),
  });

  if (existing) {
    return existing;
  }

  // Config file, then DB.
  const storageConfig = await getBackupStorageConfig();
  if (!storageConfig?.type || !storageConfig?.bucket || !storageConfig?.accessKey || !storageConfig?.secretKey) {
    return null;
  }

  const validTypes = ["s3", "r2", "b2"] as const;
  const type = storageConfig.type.toLowerCase() as (typeof validTypes)[number];
  if (!validTypes.includes(type)) {
    log.warn(
      `Invalid backup storage type: ${storageConfig.type}. Must be one of: ${validTypes.join(", ")}`
    );
    return null;
  }

  const config = {
    bucket: storageConfig.bucket,
    region: storageConfig.region || "auto",
    accessKeyId: storageConfig.accessKey,
    secretAccessKey: storageConfig.secretKey,
    ...(storageConfig.endpoint ? { endpoint: storageConfig.endpoint } : {}),
  } satisfies {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
  };

  log.info(`Creating system-level backup target (${type}://${storageConfig.bucket})`);

  const [target] = await db
    .insert(backupTargets)
    .values({
      id: nanoid(),
      organizationId: null, // system-level
      name: "System default",
      type,
      config: sealTargetConfig(config, null),
      isDefault: true,
    })
    .returning();

  return target;
}

/** Build dump/restore commands for Vardo's own Postgres from DATABASE_URL. */
function buildSystemDumpMeta(): { dumpCmd: string; restoreCmd: string } {
  const container = process.env.VARDO_PG_CONTAINER || "vardo-postgres";
  const dbUrl = process.env.DATABASE_URL || "";
  const dbMatch = dbUrl.match(/^postgresql:\/\/([A-Za-z0-9_-]+):[^@]+@[^/]+\/([A-Za-z0-9_-]+)/);
  const user = dbMatch?.[1] || "host";
  const dbname = dbMatch?.[2] || "host";
  assertSafeName(container);
  assertSafeName(user);
  assertSafeName(dbname);
  // --clean --if-exists applies over a populated database. ON_ERROR_STOP stops psql exiting 0 on failure.
  return {
    dumpCmd: `docker exec ${container} pg_dump -U ${user} --clean --if-exists ${dbname}`,
    restoreCmd: `docker exec -i ${container} psql -U ${user} -v ON_ERROR_STOP=1 -d ${dbname}`,
  };
}

/** Ensure a backup job exists for Vardo's own database. Call after ensureHostBackupTarget() succeeds. */
export async function ensureSystemBackupJob(targetId: string) {
  const existingVolume = await db.query.volumes.findFirst({
    where: and(isNull(volumes.appId), eq(volumes.name, "postgres")),
  });

  let volumeId: string;

  if (existingVolume) {
    volumeId = existingVolume.id;
  } else {
    const meta = buildSystemDumpMeta();
    volumeId = nanoid();
    await db.insert(volumes).values({
      id: volumeId,
      appId: null,
      organizationId: null,
      name: "postgres",
      mountPath: "/var/lib/postgresql/data",
      persistent: true,
      backupStrategy: "dump",
      backupMeta: meta,
    });
    log.info("Created system volume for Vardo database (dump)");
  }

  const existingLink = await db.query.backupJobVolumes.findFirst({
    where: eq(backupJobVolumes.volumeId, volumeId),
  });

  if (existingLink) {
    return db.query.backupJobs.findFirst({
      where: eq(backupJobs.id, existingLink.backupJobId),
    });
  }

  // Atomic, or a partial insert leaves an orphan job.
  const jobId = nanoid();
  const job = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(backupJobs)
      .values({
        id: jobId,
        organizationId: null,
        targetId,
        name: "Vardo database",
        schedule: staggeredSchedule("vardo-system-db"),
        enabled: true,
        keepLast: 2,
        keepDaily: 7,
        keepWeekly: 4,
        keepMonthly: 3,
        notifyOnFailure: true,
      })
      .returning();
    await tx.insert(backupJobVolumes).values({
      backupJobId: jobId,
      volumeId,
    });
    return created;
  });

  log.info("Created system backup job for Vardo database");
  return job;
}

/** Deterministic cron schedule between midnight and 5 AM, seeded by a string. */
function staggeredSchedule(seed: string): string {
  const hash = createHash("md5").update(seed).digest();
  const minute = hash[0] % 60;
  const hour = hash[1] % 6;
  return `${minute} ${hour} * * *`;
}

/** Backup target for an org: its default, then any org target, then the system target. Null if none. */
export async function resolveBackupTarget(organizationId: string) {
  const orgTarget = await db.query.backupTargets.findFirst({
    where: and(
      eq(backupTargets.organizationId, organizationId),
      eq(backupTargets.isDefault, true),
    ),
  });

  if (orgTarget) return orgTarget;

  const anyOrgTarget = await db.query.backupTargets.findFirst({
    where: eq(backupTargets.organizationId, organizationId),
  });

  if (anyOrgTarget) return anyOrgTarget;

  const hostTarget = await db.query.backupTargets.findFirst({
    where: isNull(backupTargets.organizationId),
  });

  return hostTarget ?? null;
}

/** Create a daily backup job for an app with backup-worthy volumes and no job. Returns its ID or null. */
export async function ensureAutoBackupJob(opts: {
  appId: string;
  appName: string;
  organizationId: string;
}): Promise<string | null> {
  const { appId, appName, organizationId } = opts;

  // Not `persistent`: a bind-mounted database is persistent = false and still needs a job.
  const appVolumes = await db.query.volumes.findMany({
    where: eq(volumes.appId, appId),
  });

  if (!appVolumes.some(isBackupSelected)) {
    return null;
  }

  // A job of another org does not cover the app; the engine skips it.
  const links = await db.query.backupJobApps.findMany({
    where: eq(backupJobApps.appId, appId),
    with: { backupJob: { columns: { organizationId: true } } },
  });
  const existingLink = links.find(
    (l) => l.backupJob.organizationId === organizationId || l.backupJob.organizationId === null,
  );

  if (existingLink) {
    return null;
  }

  const target = await resolveBackupTarget(organizationId);

  if (!target) {
    return null;
  }

  return createAutoJob({ appId, appName, organizationId, targetId: target.id });
}

/** Create a daily "Auto:" job on a target, linking the app atomically so no orphan job is left. */
async function createAutoJob(opts: {
  appId: string;
  appName: string;
  organizationId: string;
  targetId: string;
}): Promise<string> {
  const { appId, appName, organizationId, targetId } = opts;
  const jobId = nanoid();
  await db.transaction(async (tx) => {
    await tx.insert(backupJobs).values({
      id: jobId,
      organizationId,
      targetId,
      name: `Auto: ${appName}`,
      schedule: staggeredSchedule(appId),
      enabled: true,
      keepLast: 1,
      keepDaily: 7,
      keepWeekly: 1,
      keepMonthly: 1,
      notifyOnFailure: true,
    });
    await tx.insert(backupJobApps).values({
      backupJobId: jobId,
      appId,
    });
  });

  return jobId;
}

/** Cover an app with a job on a target, reusing a linked or "Auto: <app>" job. Returns the job ID. */
export async function ensureAutoBackupJobOnTarget(opts: {
  appId: string;
  appName: string;
  organizationId: string;
  targetId: string;
}): Promise<string> {
  const { appId, appName, organizationId, targetId } = opts;

  const onTarget = await db.query.backupJobs.findMany({
    where: and(eq(backupJobs.organizationId, organizationId), eq(backupJobs.targetId, targetId)),
    columns: { id: true, name: true },
    with: { backupJobApps: { columns: { appId: true } } },
  });

  const linked = onTarget.find((j) => j.backupJobApps.some((a) => a.appId === appId));
  if (linked) return linked.id;

  const named = onTarget.find((j) => j.name === `Auto: ${appName}`);
  if (named) {
    await db.insert(backupJobApps).values({ backupJobId: named.id, appId }).onConflictDoNothing();
    return named.id;
  }

  return createAutoJob(opts);
}
