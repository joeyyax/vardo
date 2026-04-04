import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { memberships, user } from "@/lib/db/schema";
import { requireOrgAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { verifyOrgAccess } from "@/lib/api/verify-access";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const addMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["admin", "member"]).default("member"),
}).strict();

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/members
// Returns all members of the organization
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    requireOrgAdmin(org.membership.role);

    const body = await request.json();
    const parsed = addMemberSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { email, role } = parsed.data;

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

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-members" });
