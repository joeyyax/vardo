import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq } from "drizzle-orm";
import { runRestoreDrill } from "@/lib/backups/drill";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; backupId: string }>;
};

// POST /api/v1/organizations/[orgId]/backups/history/[backupId]/drill
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId, backupId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, backupId),
      with: { app: { columns: { id: true, organizationId: true } } },
    });

    if (!backup || !backup.app || backup.app.organizationId !== orgId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (backup.status !== "success") {
      return NextResponse.json({ error: "Only a successful backup can be drilled" }, { status: 400 });
    }

    return NextResponse.json(await runRestoreDrill(backupId));
  } catch (error) {
    return handleRouteError(error, "Error running restore drill");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "backup-drill" });
