import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getDiskMetricsEnabled, setDiskMetricsEnabled } from "@/lib/metrics/disk-setting";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { collectorMode } from "@/lib/collector/config";

/** Sizes are read only alongside container metrics. */
async function applies(): Promise<boolean> {
  return collectorMode().kind !== "off" && (await isFeatureEnabledAsync("metrics"));
}

const bodySchema = z.object({ enabled: z.boolean() });

// GET /api/v1/admin/metrics/disk-metrics
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json({ enabled: await getDiskMetricsEnabled(), applies: await applies() });
  } catch (error) {
    return handleRouteError(error, "metrics-disk-metrics");
  }
}

// POST /api/v1/admin/metrics/disk-metrics — the next poll reads it.
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    await setDiskMetricsEnabled(parsed.data.enabled);
    return NextResponse.json(parsed.data);
  } catch (error) {
    return handleRouteError(error, "metrics-disk-metrics");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "metrics:disk-metrics" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/metrics/disk-metrics" });
