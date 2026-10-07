import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { isLocalBackupsAllowed } from "@/lib/config/provider-restrictions";
import { createTargetVariant, presentTarget, sealTargetConfig } from "@/lib/backups/target-config";

import { withRateLimit } from "@/lib/api/with-rate-limit";

// Local targets are org-only: their path is checked for writability on create.
const createTargetSchema = z.discriminatedUnion("type", [
  createTargetVariant("s3"),
  createTargetVariant("r2"),
  createTargetVariant("b2"),
  createTargetVariant("ssh"),
]);

// GET /api/v1/admin/backup-targets — list app-level targets
export async function GET() {
  try {
    await requireAppAdmin();

    const targets = await db.query.backupTargets.findMany({
      where: isNull(backupTargets.organizationId),
    });

    return NextResponse.json({ targets: targets.map(presentTarget), allowLocalBackups: isLocalBackupsAllowed() });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching admin backup targets");
  }
}

// POST /api/v1/admin/backup-targets — create app-level target
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = createTargetSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const data = parsed.data;

    // Reject SSH/local targets if restricted by deployment config
    if (data.type === "ssh" && !isLocalBackupsAllowed()) {
      return NextResponse.json(
        { error: "SSH/local backup targets are not available on this instance" },
        { status: 403 },
      );
    }

    const [target] = await db
      .insert(backupTargets)
      .values({
        id: nanoid(),
        organizationId: null, // app-level
        name: data.name,
        type: data.type,
        config: sealTargetConfig(data.config, null),
        isDefault: data.isDefault,
      })
      .returning();

    return NextResponse.json({ target: presentTarget(target) }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error creating admin backup target");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-backup-targets" });
