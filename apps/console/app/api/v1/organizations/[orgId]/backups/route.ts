import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import {
  backupJobs,
  backupJobApps,
  backupTargets,
  backups,
} from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { isFeatureEnabled } from "@/lib/config/features";
import { eq, and, or, desc, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

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
});

// GET /api/v1/organizations/[orgId]/backups
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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

    // Also fetch recent backup history across all jobs for this org
    // Optional ?appId= filter for scoped views (project/app detail tabs)
    const filterAppId = request.nextUrl.searchParams.get("appId");
    const jobIds = jobs.map((j) => j.id);
    const recentHistory =
      jobIds.length > 0
        ? await db.query.backups.findMany({
            where: filterAppId
              ? and(inArray(backups.jobId, jobIds), eq(backups.appId, filterAppId))
              : inArray(backups.jobId, jobIds),
            orderBy: [desc(backups.startedAt)],
            limit: 20,
            with: {
              job: { columns: { id: true, name: true } },
              app: {
                columns: { id: true, name: true, displayName: true },
              },
            },
          })
        : [];

    return NextResponse.json({ jobs, recentHistory });
  } catch (error) {
    return handleRouteError(error, "Error fetching backup jobs");
  }
}

// POST /api/v1/organizations/[orgId]/backups
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createJobSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
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

    // Create app associations
    if (data.appIds.length > 0) {
      await db.insert(backupJobApps).values(
        data.appIds.map((appId) => ({
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
