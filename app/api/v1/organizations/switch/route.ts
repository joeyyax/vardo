import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession, CURRENT_ORG_COOKIE } from "@/lib/auth/session";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

// POST /api/v1/organizations/switch
// Sets the active organization cookie after verifying membership.
async function handler(request: NextRequest) {
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const orgId = body?.organizationId;
  if (!orgId || typeof orgId !== "string") {
    return NextResponse.json({ error: "organizationId is required" }, { status: 400 });
  }

  // Verify the user is a member of this org
  const membership = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, session.user.id),
      eq(memberships.organizationId, orgId),
    ),
  });

  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  const cookieStore = await cookies();
  cookieStore.set(CURRENT_ORG_COOKIE, orgId, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handler, { tier: "mutation", key: "org-switch" });
