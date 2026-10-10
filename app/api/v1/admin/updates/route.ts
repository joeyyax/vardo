import { NextResponse, type NextRequest } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { updatePolicySchema } from "@/lib/self-update/policy";
import { getUpdateStatus } from "@/lib/self-update/status";
import { setUpdatePolicy } from "@/lib/self-update/store";

// GET /api/v1/admin/updates — version, available update, policy, last run and canary state. `?fresh=1` asks GitHub again.
async function handleGet(request: NextRequest) {
  try {
    await requireAppAdmin();
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    return NextResponse.json(await getUpdateStatus({ fresh }));
  } catch (error) {
    return handleRouteError(error);
  }
}

// PUT /api/v1/admin/updates — saves the update policy.
async function handlePut(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = updatePolicySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    await setUpdatePolicy(parsed.data);
    return NextResponse.json(await getUpdateStatus());
  } catch (error) {
    return handleRouteError(error);
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/updates" });
export const PUT = withRateLimit(handlePut, { tier: "admin", key: "admin-updates-policy" });
