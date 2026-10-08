import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { requirePlugin } from "@/lib/api/require-plugin";
import { isLocalBackupsAllowed } from "@/lib/config/provider-restrictions";
import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { createTargetSchema, presentTarget, sealTargetConfig } from "@/lib/backups/target-config";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { reconcileInBackground } from "@/lib/backups/switch";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/backups/targets
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.view");
    if (!org) return apiError.forbidden();

    // Org-level and app-level (organizationId IS NULL) targets.
    const targets = await db.query.backupTargets.findMany({
      where: or(
        eq(backupTargets.organizationId, orgId),
        isNull(backupTargets.organizationId),
      ),
    });

    const enriched = targets.map((t) => ({
      ...presentTarget(t),
      isAppLevel: t.organizationId === null,
    }));

    return NextResponse.json({
      targets: enriched,
      allowLocalBackups: isLocalBackupsAllowed(),
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching backup targets");
  }
}

// POST /api/v1/organizations/[orgId]/backups/targets
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const gate = await requirePlugin("backups");
    if (gate) return gate;
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "backup.targets.manage");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = createTargetSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const data = parsed.data;

    // Reject SSH/local targets if restricted by deployment config
    if (data.type === "ssh" && !isLocalBackupsAllowed()) {
      return NextResponse.json(
        { error: "SSH/local backup targets aren't available on this instance" },
        { status: 403 },
      );
    }

    if (data.type === "local" && !isLocalBackupsAllowed()) {
      return NextResponse.json(
        { error: "Local backup targets aren't available on this instance" },
        { status: 403 },
      );
    }

    if (data.type === "local") {
      try {
        const fs = await import("fs/promises");
        await fs.access(data.config.path, fs.constants.W_OK);
      } catch {
        return NextResponse.json(
          { error: `Directory "${data.config.path}" doesn't exist or isn't writable` },
          { status: 400 },
        );
      }
    }

    const [target] = await db
      .insert(backupTargets)
      .values({
        id: nanoid(),
        organizationId: orgId,
        name: data.name,
        type: data.type,
        config: sealTargetConfig(data.config, orgId),
        isDefault: data.isDefault,
      })
      .returning();

    // Apps left "On, no target" are enrolled now that one exists.
    reconcileInBackground({ organizationId: orgId });
    return NextResponse.json({ target: presentTarget(target) }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating backup target");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "backups-targets" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/backups/targets" });
