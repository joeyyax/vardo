import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { runChecks } from "@/lib/trust/run";
import { getTrustSettings } from "@/lib/trust/store";
import { buildTrustView } from "@/lib/trust/view";

/** POST — runs every check now. Refused while the page is off. */
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    if ((await getTrustSettings()).visibility === "off") return NextResponse.json({ error: "Trust center is off." }, { status: 409 });
    await runChecks();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error running trust checks");
  }
}

export const POST = withRateLimit(handlePost, { tier: "heavy", key: "admin-trust-run" });
