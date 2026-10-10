import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import {
  getPollIntervalMinutes,
  POLL_INTERVAL_CHOICES,
  setPollIntervalMinutes,
} from "@/lib/git-integration/poll";

import { withRateLimit } from "@/lib/api/with-rate-limit";

/** GET /api/v1/admin/auto-deploy — how often apps are polled for new commits */
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json({ configured: true, pollIntervalMinutes: await getPollIntervalMinutes() });
  } catch (error) {
    return handleRouteError(error, "Error reading auto-deploy settings");
  }
}

const schema = z
  .object({
    pollIntervalMinutes: z
      .number()
      .int()
      .refine((n) => (POLL_INTERVAL_CHOICES as readonly number[]).includes(n), "Pick one of the listed intervals"),
  })
  .strict();

/** POST /api/v1/admin/auto-deploy — set the poll interval; 0 turns polling off */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    await setPollIntervalMinutes(parsed.data.pollIntervalMinutes);
    return NextResponse.json({ ok: true, pollIntervalMinutes: parsed.data.pollIntervalMinutes });
  } catch (error) {
    return handleRouteError(error, "Error saving auto-deploy settings");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/auto-deploy" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-auto-deploy" });
