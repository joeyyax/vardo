import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getPowerPolicies, powerPoliciesSchema, setPowerPolicies } from "@/lib/power/settings";
import { resetPowerGate } from "@/lib/power/gate";
import { getPowerState } from "@/lib/ups/power-state";

/** GET /api/v1/admin/power/policies — the policies and whether a UPS backs them */
async function handleGet() {
  try {
    await requireAppAdmin();
    const [policies, power] = await Promise.all([getPowerPolicies(), getPowerState()]);
    return NextResponse.json({ policies, monitored: power.monitored });
  } catch (error) {
    return handleRouteError(error, "Error reading power policies");
  }
}

/** PUT /api/v1/admin/power/policies — replace the policies */
async function handlePut(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = powerPoliciesSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    await setPowerPolicies(parsed.data);
    resetPowerGate();
    return NextResponse.json({ policies: parsed.data });
  } catch (error) {
    return handleRouteError(error, "Error saving power policies");
  }
}

export const GET = withRateLimit(handleGet, { tier: "poll", key: "get:v1/admin/power/policies" });
export const PUT = withRateLimit(handlePut, { tier: "admin", key: "admin-power-policies" });
