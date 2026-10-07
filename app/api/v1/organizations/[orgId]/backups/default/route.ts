import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getSystemBackupsDefault, reconcileInBackground, resolveBackupSwitch } from "@/lib/backups/switch";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

async function stateOf(setting: boolean | null) {
  const systemDefault = await getSystemBackupsDefault();
  return { setting, systemDefault, ...resolveBackupSwitch(null, setting, systemDefault) };
}

// GET /api/v1/organizations/[orgId]/backups/default
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.view");
    if (!org) return apiError.forbidden();

    const row = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { backupsEnabled: true },
    });
    return NextResponse.json(await stateOf(row?.backupsEnabled ?? null));
  } catch (error) {
    return handleRouteError(error, "Error reading backup default");
  }
}

const putSchema = z.object({ enabled: z.boolean().nullable() }).strict();

// PUT /api/v1/organizations/[orgId]/backups/default — null inherits the system default
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.jobs.manage");
    if (!org) return apiError.forbidden();

    const parsed = putSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const { enabled } = parsed.data;
    await db
      .update(organizations)
      .set({ backupsEnabled: enabled, updatedAt: new Date() })
      .where(eq(organizations.id, orgId));

    reconcileInBackground({ organizationId: orgId, inheritOnly: true, reenable: true });

    return NextResponse.json(await stateOf(enabled));
  } catch (error) {
    return handleRouteError(error, "Error changing backup default");
  }
}

export const PUT = withRateLimit(handlePut, { tier: "mutation", key: "backup-default" });
