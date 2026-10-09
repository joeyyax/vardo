import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { SIZE_CLASSES, memoryMiB, sizeClass } from "@/lib/resources/defaults";
import { currentDefaults } from "@/lib/resources/host";

// GET /api/v1/admin/resources
async function handleGet() {
  try {
    await requireAppAdmin();
    const { host, defaults } = await currentDefaults();
    return NextResponse.json({
      host: host && { ...host, sizeClass: sizeClass(memoryMiB(host.memoryBytes)).name },
      defaults,
      sizeClasses: SIZE_CLASSES.map((c) => ({ ...c, belowGiB: Number.isFinite(c.belowGiB) ? c.belowGiB : null })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error reading resource defaults");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/resources" });
