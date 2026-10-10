import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { memberships, user } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { actorForOrg } from "@/lib/app-services/session-actor";
import { listMembers } from "@/lib/app-services/team";
import { requirePlugin } from "@/lib/api/require-plugin";
import { mayBeMember, SYSTEM_ORG_MEMBERS_ONLY_ADMINS } from "@/lib/auth/system-org";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const addMemberSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["admin", "member"]).default("member"),
}).strict();

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/members
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const actor = await actorForOrg(orgId);
    if (!actor) return apiError.forbidden();

    return NextResponse.json({ members: await listMembers(actor) });
  } catch (error) {
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    return handleRouteError(error, "Error fetching members");
  }
}

// POST /api/v1/organizations/[orgId]/members
// Adds an existing user by email.
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.members.manage");
    if (!org) return apiError.forbidden();

    const gate = await requirePlugin("teams");
    if (gate) return gate;

    const body = await request.json();
    const parsed = addMemberSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const { email, role } = parsed.data;

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

    if (!(await mayBeMember(orgId, targetUser.id))) {
      return NextResponse.json({ error: SYSTEM_ORG_MEMBERS_ONLY_ADMINS }, { status: 403 });
    }

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
      return apiError.forbidden();
    }
    return handleRouteError(error, "Error adding member");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-members" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/members" });
