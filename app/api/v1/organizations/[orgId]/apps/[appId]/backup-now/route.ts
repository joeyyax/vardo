import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, backupJobApps, backupJobs, backups, volumes } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { runBackup } from "@/lib/backups/engine";
import { ensureAutoBackupJob, resolveBackupTarget } from "@/lib/backups/auto-backup";
import { assessPreMigrationBackup } from "@/lib/backups/pre-migration";
import { logger } from "@/lib/logger";

const log = logger.child("backup-now");

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const bodySchema = z
  .object({
    // Ignore the in-flight guard when a previous run is wedged.
    force: z.boolean().default(false),
  })
  .strict();

// A run whose backup row is older than this is treated as abandoned. The engine
// caps tar and dump at 10 minutes each, so an hour clears any real run.
const STALE_RUN_MS = 60 * 60 * 1000;

function fail(code: string, error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, code, ...extra }, { status });
}

// POST /api/v1/organizations/[orgId]/apps/[appId]/backup-now
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      // No body — use defaults.
    }
    const parsed = bodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      return fail("INVALID_BODY", parsed.error.issues[0].message, 400);
    }

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, displayName: true, source: true },
    });

    if (!app) {
      return fail("APP_NOT_FOUND", "Not found", 404);
    }

    const appVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, appId),
      columns: { type: true, persistent: true },
    });

    const assessment = assessPreMigrationBackup({
      source: app.source,
      volumes: appVolumes.map((v) => ({ type: v.type, persistent: v.persistent })),
    });

    if (!assessment.worthBackingUp) {
      return fail(
        "NO_VOLUMES",
        "This app has no persistent volumes to back up",
        422,
        { assessment },
      );
    }

    // The engine tars named Docker volumes; a bind-mount-only app would produce
    // nothing but failed backup rows.
    if (assessment.namedVolumes === 0) {
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

    // Reuse the job this app is already covered by, otherwise let the
    // auto-backup helper create one. Both pre-conditions it checks (volumes,
    // target) are already satisfied above, so a null here means another request
    // won the race — re-read the link in that case.
    let jobId = await ensureAutoBackupJob({
      appId: app.id,
      appName: app.name,
      organizationId: orgId,
    });
    const createdJob = jobId !== null;

    if (!jobId) {
      const link = await db.query.backupJobApps.findFirst({
        where: eq(backupJobApps.appId, appId),
      });
      jobId = link?.backupJobId ?? null;
    }

    if (!jobId) {
      return fail("NO_BACKUP_JOB", "Could not resolve a backup job for this app", 500);
    }

    const job = await db.query.backupJobs.findFirst({
      where: eq(backupJobs.id, jobId),
      columns: { id: true, name: true },
    });

    if (!job) {
      return fail("NO_BACKUP_JOB", "Could not resolve a backup job for this app", 500);
    }

    // A second concurrent run would tar the same volume twice.
    if (!parsed.data.force) {
      const inFlight = await db.query.backups.findFirst({
        where: and(
          eq(backups.jobId, job.id),
          inArray(backups.status, ["pending", "running"]),
          gt(backups.startedAt, new Date(Date.now() - STALE_RUN_MS)),
        ),
        columns: { id: true, startedAt: true, volumeName: true },
      });

      if (inFlight) {
        return fail("BACKUP_IN_PROGRESS", "A backup is already running for this app", 409, {
          jobId: job.id,
          startedAt: inFlight.startedAt.toISOString(),
        });
      }
    }

    const startedAt = new Date();

    // Not awaited: a volume backup runs tar, gzip and an upload that can take
    // many minutes. The client polls the backup history instead. Scoped to this
    // app — a shared job also covers sibling apps nobody asked to back up.
    void runBackup(job.id, { appIds: [app.id] }).catch((err) => {
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
              `${assessment.bindMounts} bind mount(s) will not be captured — copy those host paths manually`,
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
