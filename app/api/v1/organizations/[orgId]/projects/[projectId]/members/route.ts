import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectMembers, memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/members
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const assignments = await db.query.projectMembers.findMany({
      where: eq(projectMembers.projectId, projectId),
      with: {
        user: {
          columns: { id: true, name: true, email: true },
        },
      },
    });

    const members = assignments.map((a) => ({
      id: a.user.id,
      name: a.user.name,
      email: a.user.email,
      assignedAt: a.createdAt,
    }));

    return NextResponse.json({ members });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error listing project members:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/members
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { userId } = body;

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    // Verify user is a member of the organization
    const orgMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, userId)
      ),
    });

    if (!orgMembership) {
      return NextResponse.json(
        { error: "User is not a member of this organization" },
        { status: 400 }
      );
    }

    // Check if already assigned
    const existing = await db.query.projectMembers.findFirst({
      where: and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId)
      ),
    });

    if (existing) {
      return NextResponse.json(
        { error: "User is already assigned to this project" },
        { status: 409 }
      );
    }

    const [created] = await db
      .insert(projectMembers)
      .values({ projectId, userId })
      .returning();

    return NextResponse.json({ member: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error assigning project member:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/members
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const userId = request.nextUrl.searchParams.get("userId");

    if (!userId) {
      return NextResponse.json(
        { error: "userId is required" },
        { status: 400 }
      );
    }

    const deleted = await db
      .delete(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, userId)
        )
      )
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json(
        { error: "Assignment not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error removing project member:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
