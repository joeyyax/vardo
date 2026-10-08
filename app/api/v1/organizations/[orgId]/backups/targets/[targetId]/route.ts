import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq, and, or, isNull } from "drizzle-orm";
import { z } from "zod";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { isAppAdmin } from "@/lib/auth/admin";
import { deleteTargetAndBackups, targetInUse, targetUsage } from "@/lib/backups/delete-backups";
import {
  mergeTargetConfig,
  presentTarget,
  sealTargetConfig,
  targetConfigSchema,
  type TargetType,
} from "@/lib/backups/target-config";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; targetId: string }>;
};

/** Gates mutations. App-level targets (organizationId NULL) need an app admin. */
async function guardTarget(orgId: string, targetId: string) {
  const target = await db.query.backupTargets.findFirst({
    where: and(
      eq(backupTargets.id, targetId),
      or(eq(backupTargets.organizationId, orgId), isNull(backupTargets.organizationId)),
    ),
  });

  if (!target) {
    return { denied: NextResponse.json({ error: "Target not found" }, { status: 404 }) };
  }

  if (target.organizationId === null && !(await isAppAdmin())) {
    return {
      denied: NextResponse.json(
        { error: "Only app admins can modify instance-level backup targets" },
        { status: 403 },
      ),
    };
  }

  return { target };
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
    const org = await verifyOrgAccess(orgId, "backup.targets.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = updateTargetSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { denied, target } = await guardTarget(orgId, targetId);
    if (denied) return denied;

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.name) updateData.name = parsed.data.name;
    if (parsed.data.config) {
      // Kept credentials stay as stored ciphertext; seal skips them.
      const merged = targetConfigSchema(target.type as TargetType).safeParse(
        mergeTargetConfig(target.config as Record<string, unknown>, parsed.data.config),
      );
      if (!merged.success) {
        return apiError.validation(merged.error);
      }
      updateData.config = sealTargetConfig(merged.data, target.organizationId);
    }
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

    return NextResponse.json({ target: presentTarget(updated) });
  } catch (error) {
    return handleRouteError(error, "Error updating backup target");
  }
}

// GET /api/v1/organizations/[orgId]/backups/targets/[targetId]
// What deleting the target would take with it.
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, targetId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.targets.manage");
    if (!org) return apiError.forbidden();

    const { denied } = await guardTarget(orgId, targetId);
    if (denied) return denied;

    return NextResponse.json({ usage: await targetUsage(targetId, orgId) });
  } catch (error) {
    return handleRouteError(error, "Error fetching backup target usage");
  }
}

const deleteTargetSchema = z.object({ confirm: z.string().optional() }).strict();

// DELETE /api/v1/organizations/[orgId]/backups/targets/[targetId]
// A target with jobs or backups is deleted only when `confirm` repeats its
// name, and then takes its archives, backups and jobs with it.
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;

    const { orgId, targetId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.targets.manage");
    if (!org) return apiError.forbidden();

    const parsed = deleteTargetSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { denied, target } = await guardTarget(orgId, targetId);
    if (denied) return denied;

    const usage = await targetUsage(targetId, orgId);
    if (usage.inProgress > 0) {
      return NextResponse.json(
        { error: "A backup is writing to this target. Try again once it finishes.", usage },
        { status: 409 },
      );
    }

    if (targetInUse(usage)) {
      if (parsed.data.confirm !== target.name) {
        return NextResponse.json(
          { error: "This target has jobs or backups. Confirm with its name to delete them too.", usage },
          { status: 409 },
        );
      }
      const result = await deleteTargetAndBackups(target);
      return NextResponse.json({ ok: true, jobs: usage.jobs, ...result });
    }

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

    return NextResponse.json({ ok: true, jobs: 0, backups: 0, archivesLeft: 0 });
  } catch (error) {
    return handleRouteError(error, "Error deleting backup target");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "backups-targets" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "backups-targets" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/backups/targets/*" });
