import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { previewHostReclaim, runHostReclaim } from "@/lib/docker/host-reclaim/run";
import { getHostReclaimConfig, getLastHostReclaim, setHostReclaimConfig } from "@/lib/docker/host-reclaim/state";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:host-reclaim");

// GET /api/v1/admin/maintenance/host-reclaim — settings, the last run and what a run would take now.
async function handleGet() {
  try {
    await requireAppAdmin();
    const [config, lastRun] = await Promise.all([getHostReclaimConfig(), getLastHostReclaim()]);
    const preview = await previewHostReclaim().catch((err) => {
      log.error(`Failed to preview host reclaim: ${err}`);
      return null;
    });
    return NextResponse.json({ config, lastRun, preview });
  } catch (error) {
    return handleRouteError(error, "host reclaim");
  }
}

// POST — runs a reclaim now. Volumes are never in scope.
async function handlePost() {
  try {
    await requireAppAdmin();
    const run = await runHostReclaim("manual");
    return NextResponse.json({ run });
  } catch (error) {
    return handleRouteError(error, "host reclaim");
  }
}

const configSchema = z
  .object({
    enabled: z.boolean(),
    minImageAgeHours: z.number().int().min(1).max(24 * 90),
  })
  .strict();

// PUT — settings.
async function handlePut(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = configSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    await setHostReclaimConfig(parsed.data);
    return NextResponse.json({ config: parsed.data });
  } catch (error) {
    return handleRouteError(error, "host reclaim settings");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/maintenance/host-reclaim" });
export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:host-reclaim" });
export const PUT = withRateLimit(handlePut, { tier: "admin", key: "maintenance:host-reclaim-config" });
