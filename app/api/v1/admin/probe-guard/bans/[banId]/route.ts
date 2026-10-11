import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getSession } from "@/lib/auth/session";
import { liftBan } from "@/lib/probe-guard/bans";

type RouteParams = { params: Promise<{ banId: string }> };

/** DELETE — lifts any ban now. */
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { banId } = await params;
    const session = await getSession().catch(() => null);
    if (!(await liftBan(banId, session?.user?.id ?? null))) return apiError.notFound("ban");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error lifting a ban");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-probe-guard-unban" });
