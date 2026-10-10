import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import {
  apps,
  backupJobs,
  backupJobApps,
  backupTargets,
  backups,
} from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq, and, or, desc, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { getOrgTimeZone } from "@/lib/time-zone-settings";
import { backupOwnerOrgId, orgBackupScope } from "@/lib/backups/org-backup";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createJobSchema = z.object({
  name: z.string().min(1, "Name is required"),
  targetId: z.string().min(1, "Target is required"),
  appIds: z.array(z.string()).min(1, "At least one app is required"),
  schedule: z.string().default("0 2 * * *"),
  enabled: z.boolean().default(true),
  keepLast: z.number().int().positive().nullable().default(1),
  keepDaily: z.number().int().positive().nullable().default(7),
  keepWeekly: z.number().int().positive().nullable().default(1),
  keepMonthly: z.number().int().positive().nullable().default(1),
  notifyOnSuccess: z.boolean().default(false),
  notifyOnFailure: z.boolean().default(true),
}).strict();

// GET /api/v1/organizations/[orgId]/backups
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.view");
    if (!org) return apiError.forbidden();

    const jobs = await db.query.backupJobs.findMany({
      where: eq(backupJobs.organizationId, orgId),
      with: {
        target: {
          columns: { id: true, name: true, type: true },
        },
        backupJobApps: {
          with: {
            app: {
              columns: { id: true, name: true, displayName: true },
              // Volume sources, so the UI can flag data the engine can't capture.
              with: {
                volumes: {
                  columns: { name: true, type: true, source: true, backupStrategy: true },
                  where: (v, { isNull }) => isNull(v.removedAt),
                },
              },
            },
          },
        },
        backups: {
          orderBy: (b, { desc }) => [desc(b.startedAt)],
          limit: 5,
          columns: {
            id: true,
            status: true,
            sizeBytes: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
      orderBy: [desc(backupJobs.createdAt)],
    });

    // Optional ?appId= filter for project/app detail tabs.
    const filterAppId = request.nextUrl.searchParams.get("appId");
    const scope = orgBackupScope(orgId);
    const rows = await db.query.backups.findMany({
      where: filterAppId ? and(scope, eq(backups.appId, filterAppId)) : scope,
      orderBy: [desc(backups.startedAt)],
      limit: 20,
      columns: { archiveKey: false },
      with: {
        job: { columns: { id: true, name: true } },
        app: {
          columns: { id: true, name: true, displayName: true, organizationId: true },
        },
      },
    });
    const recentHistory = rows.filter((b) => backupOwnerOrgId(b) === orgId);

    const timeZone = await getOrgTimeZone(orgId);
    return NextResponse.json({ jobs: jobs.map((j) => ({ ...j, timeZone })), recentHistory });
  } catch (error) {
    return handleRouteError(error, "Error fetching backup jobs");
  }
}

// POST /api/v1/organizations/[orgId]/backups
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.jobs.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = createJobSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const data = parsed.data;

    // Verify target belongs to this org or is an app-level target
    const target = await db.query.backupTargets.findFirst({
      where: and(
        eq(backupTargets.id, data.targetId),
        or(
          eq(backupTargets.organizationId, orgId),
          isNull(backupTargets.organizationId),
        ),
      ),
    });

    if (!target) {
      return NextResponse.json(
        { error: "Backup target not found" },
        { status: 404 }
      );
    }

    // Every app must belong to this org — ids come straight from the request body.
    const appIds = [...new Set(data.appIds)];
    const ownedApps = await db.query.apps.findMany({
      where: and(inArray(apps.id, appIds), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });

    if (ownedApps.length !== appIds.length) {
      return NextResponse.json(
        { error: "One or more apps not found" },
        { status: 404 }
      );
    }

    const jobId = nanoid();

    const [job] = await db
      .insert(backupJobs)
      .values({
        id: jobId,
        organizationId: orgId,
        targetId: data.targetId,
        name: data.name,
        schedule: data.schedule,
        enabled: data.enabled,
        keepLast: data.keepLast,
        keepDaily: data.keepDaily,
        keepWeekly: data.keepWeekly,
        keepMonthly: data.keepMonthly,
        notifyOnSuccess: data.notifyOnSuccess,
        notifyOnFailure: data.notifyOnFailure,
      })
      .returning();

    if (appIds.length > 0) {
      await db.insert(backupJobApps).values(
        appIds.map((appId) => ({
          backupJobId: jobId,
          appId,
        }))
      );
    }

    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating backup job");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-backups" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/backups" });
