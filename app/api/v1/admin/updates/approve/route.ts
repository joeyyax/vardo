import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { updateState } from "@/lib/self-update/store";

const approveSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{7,40}$/i) });

// POST /api/v1/admin/updates/approve — lets a canary follower take this commit without waiting on the canary.
async function handlePost(request: NextRequest) {
  try {
    const session = await requireAppAdmin();
    const parsed = approveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    const approval = { sha: parsed.data.sha.toLowerCase(), by: session.user.id, at: new Date().toISOString() };
    await updateState((s) => ({ ...s, approval }));
    return NextResponse.json({ approval });
  } catch (error) {
    return handleRouteError(error);
  }
}

// DELETE /api/v1/admin/updates/approve — withdraws the approval.
async function handleDelete() {
  try {
    await requireAppAdmin();
    await updateState((s) => ({ ...s, approval: null }));
    return NextResponse.json({ approval: null });
  } catch (error) {
    return handleRouteError(error);
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-updates-approve" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-updates-approve" });
