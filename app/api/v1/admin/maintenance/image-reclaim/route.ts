import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";

import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  imageReclaimAppSchema,
  imageReclaimConfigSchema,
  imageReclaimRunSchema,
} from "@/lib/api/admin/maintenance-schemas";
import { buildReclaimPlan } from "@/lib/docker/image-reclaim/plan";
import { buildSlotReclaimPlan } from "@/lib/docker/image-reclaim/slot-plan";
import { executeReclaimPlan } from "@/lib/docker/image-reclaim/run";
import {
  getImageReclaimConfig,
  getLastRun,
  recordLastRun,
  setImageReclaimConfig,
} from "@/lib/docker/image-reclaim/settings";
import { SKIP_COPY } from "@/lib/docker/image-reclaim/policy";
import { SLOT_SKIP_COPY } from "@/lib/docker/image-reclaim/slot-policy";

const log = logger.child("admin:maintenance:image-reclaim");

// GET /api/v1/admin/maintenance/image-reclaim — the plan a run would execute, plus the last run's outcome.
// Sizes are an upper bound since images share layers.
export async function GET() {
  try {
    await requireAppAdmin();

    const config = await getImageReclaimConfig();
    const lastRun = await getLastRun();

    let plan = null;
    try {
      const built = await buildReclaimPlan(config.idleDays);
      plan = {
        ...built,
        skipped: built.skipped.map((s) => ({ ...s, explanation: SKIP_COPY[s.reason] })),
      };
    } catch (err) {
      log.error(`Failed to build reclaim plan: ${err}`);
    }

    let slotPlan = null;
    try {
      const built = await buildSlotReclaimPlan();
      slotPlan = {
        ...built,
        skipped: built.skipped.map((s) => ({ ...s, explanation: SLOT_SKIP_COPY[s.reason] })),
      };
    } catch (err) {
      log.error(`Failed to build slot reclaim plan: ${err}`);
    }

    return NextResponse.json({ config, lastRun, plan, slotPlan });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/maintenance/image-reclaim — runs the plan. `dryRun` returns what would be removed.
// Volumes are never in scope.
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json().catch(() => ({}));
    const parsed = imageReclaimRunSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const config = await getImageReclaimConfig();
    const plan = await buildReclaimPlan(config.idleDays);
    const result = await executeReclaimPlan(plan, { dryRun: parsed.data.dryRun });

    if (!parsed.data.dryRun) {
      await recordLastRun(result);
      log.info(`Manual reclaim removed ${result.reclaimed.length} image(s)`);
    }

    // Opt-in per request so a plain run can't reach an unpreviewed generation.
    let slotResult = null;
    if (parsed.data.slots) {
      const slotPlan = await buildSlotReclaimPlan();
      slotResult = await executeReclaimPlan(slotPlan, { dryRun: parsed.data.dryRun });
      if (!parsed.data.dryRun) {
        log.info(`Manual slot reclaim removed ${slotResult.reclaimed.length} image(s)`);
      }
    }

    return NextResponse.json({ ok: true, result, slotResult });
  } catch (error) {
    return handleRouteError(error, "image reclaim");
  }
}

// PUT — instance settings.
async function handlePut(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json().catch(() => ({}));
    const parsed = imageReclaimConfigSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    await setImageReclaimConfig(parsed.data);
    return NextResponse.json({ ok: true, config: parsed.data });
  } catch (error) {
    return handleRouteError(error, "image reclaim settings");
  }
}

// PATCH — per-app override. "never" pins an app; "always" opts a floating tag in.
async function handlePatch(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json().catch(() => ({}));
    const parsed = imageReclaimAppSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const { appId, policy, idleDays } = parsed.data;
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (policy !== undefined) update.imageReclaimPolicy = policy;
    if (idleDays !== undefined) update.imageReclaimIdleDays = idleDays;

    const [updated] = await db
      .update(apps)
      .set(update)
      .where(eq(apps.id, appId))
      .returning({ id: apps.id });

    if (!updated) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "image reclaim app policy");
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:image-reclaim" });
export const PUT = withRateLimit(handlePut, { tier: "admin", key: "maintenance:image-reclaim-config" });
export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "maintenance:image-reclaim-app" });
