import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { isFeatureEnabled } from "@/lib/config/features";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; targetId: string }>;
};

const updateTargetSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().optional(),
});

// PATCH /api/v1/organizations/[orgId]/backups/targets/[targetId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId, targetId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

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
      .where(eq(backupTargets.id, targetId))
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
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    if (!isFeatureEnabled("backups")) {
      return NextResponse.json({ error: "Feature not enabled" }, { status: 404 });
    }

    const { orgId, targetId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const deleted = await db
      .delete(backupTargets)
      .where(eq(backupTargets.id, targetId))
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Target not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting backup target");
  }
}
