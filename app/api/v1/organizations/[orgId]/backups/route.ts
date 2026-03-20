import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  backupJobs,
  backupJobProjects,
  backupTargets,
  backups,
} from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc, inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createJobSchema = z.object({
  name: z.string().min(1, "Name is required"),
  targetId: z.string().min(1, "Target is required"),
  projectIds: z.array(z.string()).min(1, "At least one project is required"),
  schedule: z.string().default("0 2 * * *"),
  enabled: z.boolean().default(true),
  keepLast: z.number().int().positive().nullable().optional(),
  keepDaily: z.number().int().positive().nullable().optional(),
  keepWeekly: z.number().int().positive().nullable().optional(),
  keepMonthly: z.number().int().positive().nullable().optional(),
  notifyOnSuccess: z.boolean().default(false),
  notifyOnFailure: z.boolean().default(true),
});

// GET /api/v1/organizations/[orgId]/backups
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
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
        backupJobProjects: {
          with: {
            project: {
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
    const jobIds = jobs.map((j) => j.id);
    const recentHistory =
      jobIds.length > 0
        ? await db.query.backups.findMany({
            where: inArray(backups.jobId, jobIds),
            orderBy: [desc(backups.startedAt)],
            limit: 20,
            with: {
              job: { columns: { id: true, name: true } },
              project: {
                columns: { id: true, name: true, displayName: true },
              },
            },
          })
        : [];

    return NextResponse.json({ jobs, recentHistory });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching backup jobs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/backups
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
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

    // Verify target belongs to this org
    const target = await db.query.backupTargets.findFirst({
      where: and(
        eq(backupTargets.id, data.targetId),
        eq(backupTargets.organizationId, orgId)
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

    // Create project associations
    if (data.projectIds.length > 0) {
      await db.insert(backupJobProjects).values(
        data.projectIds.map((projectId) => ({
          backupJobId: jobId,
          projectId,
        }))
      );
    }

    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating backup job:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
