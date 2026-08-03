import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq, and, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAppAdmin } from "@/lib/auth/admin";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; targetId: string }>;
};

/**
 * Gate mutations on a target. App-level targets (organizationId NULL) are
 * visible to the org but only app admins may modify them.
 * Returns a response to send, or null when the caller may proceed.
 */
async function guardTarget(orgId: string, targetId: string) {
  const target = await db.query.backupTargets.findFirst({
    where: and(
      eq(backupTargets.id, targetId),
      or(eq(backupTargets.organizationId, orgId), isNull(backupTargets.organizationId)),
    ),
    columns: { id: true, organizationId: true },
  });

  if (!target) {
    return NextResponse.json({ error: "Target not found" }, { status: 404 });
  }

  if (target.organizationId === null && !(await isAppAdmin())) {
    return NextResponse.json(
      { error: "Only app admins can modify instance-level backup targets" },
      { status: 403 },
    );
  }

  return null;
}

const updateTargetSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isDefault: z.boolean().optional(),
}).strict();

// PATCH /api/v1/organizations/[orgId]/backups/targets/[targetId]
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

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

    const denied = await guardTarget(orgId, targetId);
    if (denied) return denied;

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
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, targetId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const denied = await guardTarget(orgId, targetId);
    if (denied) return denied;

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
