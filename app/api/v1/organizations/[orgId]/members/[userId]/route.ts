import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; userId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/members/[userId]
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;
    const org = await verifyOrgAccess(orgId, "org.members.manage");
    if (!org) return apiError.forbidden();

    const gate = await requirePlugin("teams");
    if (gate) return gate;

    const body = await request.json();
    const { role } = body;

    if (role !== "admin" && role !== "member") {
      return NextResponse.json(
        { error: "Role must be 'admin' or 'member'" },
        { status: 400 }
      );
    }

    const targetMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId)
      ),
    });

    if (!targetMembership) {
      return NextResponse.json(
        { error: "Member not found" },
        { status: 404 }
      );
    }

    if (targetMembership.role === "owner") {
      return NextResponse.json(
        { error: "Cannot change the owner's role" },
        { status: 403 }
      );
    }

    const [updated] = await db
      .update(memberships)
      .set({ role })
      .where(eq(memberships.id, targetMembership.id))
      .returning();

    return NextResponse.json({
      member: { id: updated.userId, role: updated.role },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error updating member role");
  }
}

// DELETE /api/v1/organizations/[orgId]/members/[userId]
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;
    const org = await verifyOrgAccess(orgId, "org.members.manage");
    if (!org) return apiError.forbidden();

    const gate = await requirePlugin("teams");
    if (gate) return gate;

    const targetMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId)
      ),
    });

    if (!targetMembership) {
      return NextResponse.json(
        { error: "Member not found" },
        { status: 404 }
      );
    }

    if (targetMembership.role === "owner") {
      return NextResponse.json(
        { error: "Cannot remove the organization owner" },
        { status: 403 }
      );
    }

    if (userId === org.session.user.id) {
      return NextResponse.json(
        { error: "Cannot remove yourself" },
        { status: 400 }
      );
    }

    await db
      .delete(memberships)
      .where(eq(memberships.id, targetMembership.id));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error removing member");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-members" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-members" });
