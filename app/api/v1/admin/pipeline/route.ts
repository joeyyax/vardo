import { NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { readPipelineSnapshot } from "@/lib/pipeline/read";

// GET /api/v1/admin/pipeline
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json(await readPipelineSnapshot());
  } catch (error) {
    return handleRouteError(error, "Error reading the pipeline");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/pipeline" });
