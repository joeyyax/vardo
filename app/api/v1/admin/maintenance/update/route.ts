import { NextRequest, NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { UpdateBlockedError } from "@/lib/self-update/runner";
import { updateNow } from "@/lib/self-update/update-now";

// POST /api/v1/admin/maintenance/update — Update now.
async function handlePost(_request: NextRequest) {
  try {
    const session = await requireAppAdmin();
    try {
      return NextResponse.json(await updateNow(session.user.id));
    } catch (err) {
      if (err instanceof UpdateBlockedError) return NextResponse.json({ error: err.message }, { status: 409 });
      throw err;
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:update" });
