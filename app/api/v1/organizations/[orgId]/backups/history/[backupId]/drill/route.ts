import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requirePlugin } from "@/lib/api/require-plugin";
import { runRestoreDrill } from "@/lib/backups/drill";
import { findOrgAppBackup } from "@/lib/backups/org-backup";
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
    const org = await verifyOrgAccess(orgId, "backup.run");
    if (!org) return apiError.forbidden();

    const backup = await findOrgAppBackup(orgId, backupId);
    if (!backup) {
      return apiError.notFound("backup");
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
