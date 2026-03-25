import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; userId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/members/[userId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    requireAdmin(org.membership.role);

    const body = await request.json();
    const { role } = body;

    if (role !== "admin" && role !== "member") {
      return NextResponse.json(
        { error: "Role must be 'admin' or 'member'" },
        { status: 400 }
      );
    }

    // Find target membership
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
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error updating member role");
  }
}

// DELETE /api/v1/organizations/[orgId]/members/[userId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    requireAdmin(org.membership.role);

    // Find target membership
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
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error removing member");
  }
}
