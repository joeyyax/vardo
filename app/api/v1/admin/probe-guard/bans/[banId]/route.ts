import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getSession } from "@/lib/auth/session";
import { liftBan, makeBanPermanent } from "@/lib/probe-guard/bans";
import { banPatchSchema } from "@/lib/probe-guard/settings";

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

/** PATCH — makes any ban permanent. */
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { banId } = await params;
    const parsed = banPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const session = await getSession().catch(() => null);
    if (!(await makeBanPermanent(banId, session?.user?.id ?? null))) return apiError.notFound("ban");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error changing a ban");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-probe-guard-permanent" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-probe-guard-unban" });
