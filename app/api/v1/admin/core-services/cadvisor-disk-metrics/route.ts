import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";

import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getCadvisorConfig, setCadvisorConfig, applyCadvisorDiskMetrics } from "@/lib/infra/cadvisor-config";
import { loadTemplates } from "@/lib/templates/load";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { logger } from "@/lib/logger";

const log = logger.child("admin:core-services:cadvisor");

const bodySchema = z.object({ diskMetricsEnabled: z.boolean() });

// GET /api/v1/admin/core-services/cadvisor-disk-metrics
export async function GET() {
  try {
    await requireAppAdmin();
    return NextResponse.json(await getCadvisorConfig());
  } catch (error) {
    return handleRouteError(error, "core-services-cadvisor");
  }
}

// POST /api/v1/admin/core-services/cadvisor-disk-metrics
//
// Saves the setting and, when cAdvisor is already installed, redeploys it
// immediately so the toggle takes effect without waiting for a restart.
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    await setCadvisorConfig(parsed.data);

    const existing = await db.query.apps.findFirst({
      where: and(eq(apps.name, "cadvisor"), isNull(apps.parentAppId)),
      columns: { id: true, organizationId: true, isSystemManaged: true },
    });

    if (!existing || !existing.isSystemManaged) {
      return NextResponse.json({ ...parsed.data, installed: false, redeployed: false });
    }

    const templates = await loadTemplates();
    const template = templates.find((t) => t.name === "cadvisor");
    if (!template?.composeContent) {
      return NextResponse.json({ ...parsed.data, installed: true, redeployed: false });
    }

    const composeContent = applyCadvisorDiskMetrics(template.composeContent, parsed.data.diskMetricsEnabled);
    await db
      .update(apps)
      .set({ composeContent, needsRedeploy: true, updatedAt: new Date() })
      .where(eq(apps.id, existing.id));

    let redeployed = false;
    try {
      const result = await requestDeploy({
        appId: existing.id,
        organizationId: existing.organizationId,
        trigger: "api",
      });
      redeployed = !!result?.success;
    } catch (err) {
      log.error("Redeploy threw after disk metrics toggle:", err);
    }
    if (!redeployed) log.error("Redeploy failed after disk metrics toggle");

    return NextResponse.json({ ...parsed.data, installed: true, redeployed });
  } catch (error) {
    return handleRouteError(error, "core-services-cadvisor");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "core-services:cadvisor-disk-metrics" });
