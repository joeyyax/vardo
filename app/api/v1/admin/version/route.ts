import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getVersionData } from "@/lib/version";

// GET /api/v1/admin/version
async function handleGet() {
  try {
    await requireAppAdmin();
    const data = await getVersionData();
    return NextResponse.json(data);
  } catch (error) {
    return handleRouteError(error, "Error checking version");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/version" });
