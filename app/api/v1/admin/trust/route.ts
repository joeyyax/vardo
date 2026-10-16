import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { runChecks } from "@/lib/trust/run";
import { clearResults, getTrustSettings, updateTrustSettings } from "@/lib/trust/store";
import { buildTrustView } from "@/lib/trust/view";
import { VISIBILITIES } from "@/lib/trust/types";

const patchSchema = z
  .object({
    visibility: z.enum(VISIBILITIES),
    hostingOverride: z.object({ provider: z.string().trim().max(80), region: z.string().trim().max(80) }).nullable(),
  })
  .partial()
  .strict();

/** GET — settings, hosting, the latest check results and the level they give. */
async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error reading trust center");
  }
}

/** PATCH — saves settings. Turning the page on runs the checks; turning it off stops them and clears the results. */
async function handlePatch(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    const before = await getTrustSettings();
    const patch = parsed.data;
    if (patch.hostingOverride && !patch.hostingOverride.provider) patch.hostingOverride = null;
    const after = await updateTrustSettings(patch);
    if (after.visibility === "off") {
      if (before.visibility !== "off") await clearResults();
    } else if (before.visibility === "off" || patch.hostingOverride !== undefined) {
      await runChecks();
    }
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error saving trust center");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/trust" });
export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-trust" });
