import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, isNull } from "drizzle-orm";

import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { getCadvisorConfig, setCadvisorConfig, applyCadvisorDiskMetrics } from "@/lib/infra/cadvisor-config";
import { loadTemplates } from "@/lib/templates/load";
import { enqueueDeploy } from "@/lib/deploy/queue";
import { logger } from "@/lib/logger";

const log = logger.child("admin:core-services:cadvisor");

const bodySchema = z.object({ diskMetricsEnabled: z.boolean() });

// GET /api/v1/admin/core-services/cadvisor-disk-metrics
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json(await getCadvisorConfig());
  } catch (error) {
    return handleRouteError(error, "core-services-cadvisor");
  }
}

// POST /api/v1/admin/core-services/cadvisor-disk-metrics — saves the setting and redeploys cAdvisor if installed.
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    await setCadvisorConfig(parsed.data);

    const existing = await db.query.apps.findFirst({
      where: and(eq(apps.name, "cadvisor"), isNull(apps.parentAppId)),
      columns: { id: true, organizationId: true, isSystemManaged: true },
    });

    if (!existing || !existing.isSystemManaged) {
      return NextResponse.json({ ...parsed.data, installed: false, deploymentId: null });
    }

    const templates = await loadTemplates();
    const template = templates.find((t) => t.name === "cadvisor");
    if (!template?.composeContent) {
      return NextResponse.json({ ...parsed.data, installed: true, deploymentId: null });
    }

    const composeContent = applyCadvisorDiskMetrics(template.composeContent, parsed.data.diskMetricsEnabled);
    await db
      .update(apps)
      .set({ composeContent, needsRedeploy: true, updatedAt: new Date() })
      .where(eq(apps.id, existing.id));

    try {
      const { id } = await enqueueDeploy({ appId: existing.id, trigger: "api" });
      return NextResponse.json({ ...parsed.data, installed: true, deploymentId: id }, { status: 202 });
    } catch (err) {
      log.error("Couldn't queue the redeploy after the disk metrics toggle:", err);
      return NextResponse.json({ ...parsed.data, installed: true, deploymentId: null });
    }
  } catch (error) {
    return handleRouteError(error, "core-services-cadvisor");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "core-services:cadvisor-disk-metrics" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/core-services/cadvisor-disk-metrics" });
