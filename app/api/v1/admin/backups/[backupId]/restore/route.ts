import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backups } from "@/lib/db/schema";
import { requireAppAdmin } from "@/lib/auth/admin";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq } from "drizzle-orm";
import { restoreBackup } from "@/lib/backup/engine";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ backupId: string }>;
};

// POST /api/v1/admin/backups/[backupId]/restore
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    await requireAppAdmin();
    const { backupId } = await params;

    const backup = await db.query.backups.findFirst({
      where: eq(backups.id, backupId),
    });

    if (!backup) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (backup.status !== "success") {
      return NextResponse.json(
        { error: "Only successful backups can be restored" },
        { status: 400 },
      );
    }

    if (backup.appId !== null) {
      return NextResponse.json(
        { error: "Use the org-scoped restore endpoint for app backups" },
        { status: 400 },
      );
    }

    const result = await restoreBackup(backupId);

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error restoring system backup");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "backups-restore" });
