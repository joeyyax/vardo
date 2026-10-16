import { NextRequest, NextResponse } from "next/server";
import { apiError, describeIssue, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, backupJobApps, backupJobs } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { startManualBackup } from "@/lib/backups/manual-run";
import { ensureAutoBackupJob, resolveBackupTarget } from "@/lib/backups/auto-backup";
import { resolveAppBackupSwitch } from "@/lib/backups/switch";
import { assessPreMigrationBackup } from "@/lib/backups/pre-migration";
import { isBackupSelected } from "@/lib/backups/durability";
import { isUncapturedSource } from "@/lib/backups/coverage";
import { logger } from "@/lib/logger";
import { liveVolumesOf } from "@/lib/volumes/reconcile";

const log = logger.child("backup-now");

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const bodySchema = z
  .object({
    // Start past a wedged in-flight row, never past a live run of the job.
    force: z.boolean().default(false),
  })
  .strict();

function fail(code: string, error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, code, ...extra }, { status });
}

// POST /api/v1/organizations/[orgId]/apps/[appId]/backup-now
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.run");
    if (!org) return apiError.forbidden();

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // No body — use defaults.
    }
    const parsed = bodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail("INVALID_BODY", describeIssue(parsed.error.issues[0]), 400);
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, displayName: true, source: true },
    });

    if (!app) {
      return fail("APP_NOT_FOUND", "App not found.", 404);
    }

    const appVolumes = await db.query.volumes.findMany({
      where: liveVolumesOf(appId),
      columns: {
        type: true,
        persistent: true,
        durability: true,
        backupStrategy: true,
        backupSelection: true,
      },
    });

    const assessment = assessPreMigrationBackup({
      source: app.source,
      volumes: appVolumes.map((v) => ({ type: v.type, persistent: v.persistent })),
    });

    // What a run would capture, opted-in bind mounts included.
    const captured = appVolumes.filter((v) => isBackupSelected(v) && !isUncapturedSource(v));

    if (!assessment.worthBackingUp && captured.length === 0) {
      return fail(
        "NO_VOLUMES",
        "This app has no persistent volumes to back up",
        422,
        { assessment },
      );
    }

    // The engine only tars named Docker volumes.
    if (captured.length === 0) {
      return fail(
        "BIND_MOUNTS_ONLY",
        "This app's only persistent data is on bind mounts, which must be copied from the host",
        422,
        { assessment },
      );
    }

    const target = await resolveBackupTarget(orgId);
    if (!target) {
      return fail(
        "NO_BACKUP_TARGET",
        "No backup target is configured for this organization",
        409,
      );
    }

    // Reuse the app's job or create one; null means another request won the race.
    let jobId = await ensureAutoBackupJob({
      appId: app.id,
      appName: app.name,
      organizationId: orgId,
    });
    const createdJob = jobId !== null;
    // An app switched off gets its one backup, not a schedule.
    if (jobId && (await resolveAppBackupSwitch(app.id))?.enabled === false) {
      await db.update(backupJobs).set({ enabled: false }).where(eq(backupJobs.id, jobId));
    }

    if (!jobId) {
      const link = await db.query.backupJobApps.findFirst({
        where: eq(backupJobApps.appId, appId),
      });
      jobId = link?.backupJobId ?? null;
    }

    if (!jobId) {
      return fail("NO_BACKUP_JOB", "Couldn't resolve a backup job for this app", 500);
    }

    const job = await db.query.backupJobs.findFirst({
      where: eq(backupJobs.id, jobId),
      columns: { id: true, name: true },
    });

    if (!job) {
      return fail("NO_BACKUP_JOB", "Couldn't resolve a backup job for this app", 500);
    }

    const startedAt = new Date();

    // Scoped to this app since a shared job also covers its siblings. A second concurrent run would tar the same volume twice.
    const start = await startManualBackup(job.id, { appIds: [app.id], force: parsed.data.force });
    if (!start.started) {
      return fail("BACKUP_IN_PROGRESS", "Using the backup of this app already in progress", 409, {
        jobId: job.id,
        ...(start.startedAt ? { startedAt: start.startedAt.toISOString() } : {}),
      });
    }

    // Not awaited: a volume backup can take minutes, so the client polls history.
    start.done.catch((err) => {
      log.error(`Manual backup failed for app ${app.name} (job ${job.id}):`, err);
    });

    return NextResponse.json(
      {
        status: "started",
        jobId: job.id,
        jobName: job.name,
        createdJob,
        startedAt: startedAt.toISOString(),
        appIds: [app.id],
        assessment,
        warnings: assessment.needsManualCopy
          ? [
              `${assessment.bindMounts} bind mount(s) won't be captured — copy those host paths manually`,
            ]
          : [],
        poll: {
          url: `/api/v1/organizations/${orgId}/backups?appId=${appId}`,
          field: "recentHistory",
        },
      },
      { status: 202 },
    );
  } catch (error) {
    return handleRouteError(error, "Error starting backup");
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "apps-backup-now" });
