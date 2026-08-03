import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, backupJobs, backupJobApps, backupTargets } from "@/lib/db/schema";
import { eq, and, or, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

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
}).strict();

// GET /api/v1/organizations/[orgId]/backups/[jobId]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, jobId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, jobId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = updateJobSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { appIds, ...updateData } = parsed.data;

    // Every app must belong to this org — ids come straight from the request body.
    const uniqueAppIds = appIds ? [...new Set(appIds)] : undefined;
    if (uniqueAppIds && uniqueAppIds.length > 0) {
      const ownedApps = await db.query.apps.findMany({
        where: and(inArray(apps.id, uniqueAppIds), eq(apps.organizationId, orgId)),
        columns: { id: true },
      });

      if (ownedApps.length !== uniqueAppIds.length) {
        return NextResponse.json(
          { error: "One or more apps not found" },
          { status: 404 }
        );
      }
    }

    // Same for the target — org-owned or instance-level only.
    if (updateData.targetId) {
      const target = await db.query.backupTargets.findFirst({
        where: and(
          eq(backupTargets.id, updateData.targetId),
          or(
            eq(backupTargets.organizationId, orgId),
            isNull(backupTargets.organizationId),
          ),
        ),
        columns: { id: true },
      });

      if (!target) {
        return NextResponse.json(
          { error: "Backup target not found" },
          { status: 404 }
        );
      }
    }

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
    if (uniqueAppIds) {
      // Remove existing
      await db
        .delete(backupJobApps)
        .where(eq(backupJobApps.backupJobId, jobId));

      // Insert new
      if (uniqueAppIds.length > 0) {
        await db.insert(backupJobApps).values(
          uniqueAppIds.map((appId) => ({
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
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, jobId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (org.membership.role !== "owner" && org.membership.role !== "admin") {
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

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "backups-jobs" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "backups-jobs" });
