import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { isFeatureEnabled } from "@/lib/config/features";
import { eq, and, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; targetId: string }>;
};

const updateTargetSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/backups/targets/[targetId]
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId, targetId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = updateTargetSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name) updateData.name = parsed.data.name;
    if (parsed.data.config) updateData.config = parsed.data.config;
    if (parsed.data.isDefault !== undefined) updateData.isDefault = parsed.data.isDefault;

    const [updated] = await db
      .update(backupTargets)
      .set(updateData)
      .where(and(
        eq(backupTargets.id, targetId),
        or(eq(backupTargets.organizationId, orgId), isNull(backupTargets.organizationId))
      ))
      .returning();

    if (!updated) {
      return NextResponse.json({ error: "Target not found" }, { status: 404 });
    }

    return NextResponse.json({ target: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating backup target");
  }
}

// DELETE /api/v1/organizations/[orgId]/backups/targets/[targetId]
async function handleDelete(_request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId, targetId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const deleted = await db
      .delete(backupTargets)
      .where(and(
        eq(backupTargets.id, targetId),
        or(eq(backupTargets.organizationId, orgId), isNull(backupTargets.organizationId))
      ))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Target not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting backup target");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "backups-targets" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "backups-targets" });
