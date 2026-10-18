import { NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { readAppsSnapshot } from "@/lib/admin-apps/read";

// GET /api/v1/admin/apps
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json(await readAppsSnapshot());
  } catch (error) {
    return handleRouteError(error, "Error reading apps");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/apps" });
