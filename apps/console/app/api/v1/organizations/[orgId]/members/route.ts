import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { memberships, user } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/members
// Returns all members of the organization
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const orgMemberships = await db.query.memberships.findMany({
      where: eq(memberships.organizationId, orgId),
      with: {
        user: {
          columns: { id: true, name: true, email: true },
        },
      },
    });

    const members = orgMemberships.map((m) => ({
      id: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt.toISOString(),
    }));

    return NextResponse.json({ members });
  } catch (error) {
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    return handleRouteError(error, "Error fetching members");
  }
}

// POST /api/v1/organizations/[orgId]/members
// Add a member by email (user must already have an account)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { email, role = "member" } = body;

    if (!email || typeof email !== "string") {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    if (role !== "admin" && role !== "member") {
      return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
    }

    // Find the user by email
    const targetUser = await db.query.user.findFirst({
      where: eq(user.email, email.trim().toLowerCase()),
      columns: { id: true, name: true, email: true },
    });

    if (!targetUser) {
      return NextResponse.json(
        { error: "No user found with that email. They need to create an account first." },
        { status: 404 }
      );
    }

    // Check if already a member
    const existing = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, orgId),
        eq(memberships.userId, targetUser.id)
      ),
    });

    if (existing) {
      return NextResponse.json(
        { error: "This user is already a member of this organization" },
        { status: 409 }
      );
    }

    // Create membership
    await db.insert(memberships).values({
      id: nanoid(),
      userId: targetUser.id,
      organizationId: orgId,
      role,
    });

    return NextResponse.json({
      member: {
        id: targetUser.id,
        name: targetUser.name,
        email: targetUser.email,
        role,
      },
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error adding member");
  }
}
