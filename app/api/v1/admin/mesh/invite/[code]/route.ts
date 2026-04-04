import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { cancelInvite } from "@/lib/mesh/invite";

import { withRateLimit } from "@/lib/api/with-rate-limit";

/** DELETE /api/v1/admin/mesh/invite/[code] — cancel a pending invite */
async function handleDelete(
  _request: Request,
  { params }: { params: Promise<{ code: string }> }
) {
  try {
    await requireAppAdmin();

    const { code } = await params;
    const deleted = await cancelInvite(code);

    if (!deleted) {
      return NextResponse.json(
        { error: "Invite not found or already used" },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error cancelling invite");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "mesh-invite" });
