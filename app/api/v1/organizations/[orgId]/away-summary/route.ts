import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { getAwaySummary, resolveSince } from "@/lib/away";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

async function markSeen(membershipId: string, at: Date) {
  await db
    .update(memberships)
    .set({ lastSeenAt: at })
    .where(eq(memberships.id, membershipId));
}

// GET /api/v1/organizations/[orgId]/away-summary
// What happened since this member was last here. Returns summary: null when
// there is nothing worth interrupting for, and advances the anchor in that case
// so the window does not grow.
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const membership = await db.query.memberships.findFirst({
      where: eq(memberships.id, org.membership.id),
      columns: { id: true, lastSeenAt: true },
    });
    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const now = new Date();
    const since = resolveSince(membership.lastSeenAt, now);
    if (!since) {
      await markSeen(membership.id, now);
      return NextResponse.json({ summary: null });
    }

    const summary = await getAwaySummary({
      orgId,
      userId: org.session.user.id,
      since,
      now,
    });

    if (!summary.shouldSurface) {
      await markSeen(membership.id, now);
      return NextResponse.json({ summary: null });
    }

    return NextResponse.json({ summary });
  } catch (error) {
    return handleRouteError(error, "Error building away summary");
  }
}

// POST /api/v1/organizations/[orgId]/away-summary — dismiss.
async function handlePost(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    await markSeen(org.membership.id, new Date());
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error dismissing away summary");
  }
}

export const POST = withRateLimit(handlePost, {
  tier: "mutation",
  key: "organizations-away-summary",
});
