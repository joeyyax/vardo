import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupJobs, backupJobApps } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; jobId: string }>;
};

const updateJobSchema = z.object({
  name: z.string().min(1).optional(),
  schedule: z.string().optional(),
  enabled: z.boolean().optional(),
  targetId: z.string().optional(),
  appIds: z.array(z.string()).optional(),
  keepLast: z.number().int().positive().nullable().optional(),
  keepDaily: z.number().int().positive().nullable().optional(),
  keepWeekly: z.number().int().positive().nullable().optional(),
  keepMonthly: z.number().int().positive().nullable().optional(),
  notifyOnSuccess: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
});

// GET /api/v1/organizations/[orgId]/backups/[jobId]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, jobId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const job = await db.query.backupJobs.findFirst({
      where: and(
        eq(backupJobs.id, jobId),
        eq(backupJobs.organizationId, orgId)
      ),
      with: {
        target: true,
        backupJobApps: {
          with: {
            app: {
              columns: { id: true, name: true, displayName: true },
            },
          },
        },
        backups: {
          orderBy: (b, { desc }) => [desc(b.startedAt)],
          limit: 20,
        },
      },
    });

    if (!job) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ job });
  } catch (error) {
    return handleRouteError(error, "Error fetching backup job");
  }
}

// PATCH /api/v1/organizations/[orgId]/backups/[jobId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, jobId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = updateJobSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { appIds, ...updateData } = parsed.data;

    const [updated] = await db
      .update(backupJobs)
      .set({ ...updateData, updatedAt: new Date() })
      .where(
        and(eq(backupJobs.id, jobId), eq(backupJobs.organizationId, orgId))
      )
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Update app associations if provided
    if (appIds) {
      // Remove existing
      await db
        .delete(backupJobApps)
        .where(eq(backupJobApps.backupJobId, jobId));

      // Insert new
      if (appIds.length > 0) {
        await db.insert(backupJobApps).values(
          appIds.map((appId) => ({
            backupJobId: jobId,
            appId,
          }))
        );
      }
    }

    return NextResponse.json({ job: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating backup job");
  }
}

// DELETE /api/v1/organizations/[orgId]/backups/[jobId]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, jobId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (membership.role !== "owner" && membership.role !== "admin") {
      return NextResponse.json(
        { error: "Only owners and admins can delete backup jobs" },
        { status: 403 }
      );
    }

    const existing = await db.query.backupJobs.findFirst({
      where: and(
        eq(backupJobs.id, jobId),
        eq(backupJobs.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db
      .delete(backupJobs)
      .where(
        and(eq(backupJobs.id, jobId), eq(backupJobs.organizationId, orgId))
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting backup job");
  }
}
