import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { organizations, teamInvitations, memberships, type OrgFeatures } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and, sql } from "drizzle-orm";

// POST /api/v1/team-invitations/accept
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();
    const body = await request.json();
    const { token, type = "invitation" } = body;

    if (!token || typeof token !== "string") {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    if (type === "join") {
      return handleJoinLink(session.user.id, token);
    }

    return handleInvitation(session.user.id, token);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error accepting invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function checkSecondMemberNudge(orgId: string) {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(memberships)
    .where(eq(memberships.organizationId, orgId));
  if (Number(count) === 2) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { features: true },
    });
    const features = (org?.features as OrgFeatures) || {};
    if (features.defaultAssignee) {
      await db
        .update(organizations)
        .set({ features: { ...features, secondMemberNudge: true } })
        .where(eq(organizations.id, orgId));
    }
  }
}

async function handleJoinLink(userId: string, token: string) {
  // Find org with matching join token that is enabled
  const org = await db.query.organizations.findFirst({
    where: and(
      eq(organizations.joinToken, token),
      eq(organizations.joinEnabled, true)
    ),
  });

  if (!org) {
    return NextResponse.json(
      { error: "Invalid or disabled join link" },
      { status: 404 }
    );
  }

  // Check if already a member
  const existing = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, userId),
      eq(memberships.organizationId, org.id)
    ),
  });

  if (existing) {
    return NextResponse.json(
      { error: "You are already a member of this organization" },
      { status: 409 }
    );
  }

  // Create membership
  await db.insert(memberships).values({
    userId,
    organizationId: org.id,
    role: "member",
  });

  await checkSecondMemberNudge(org.id);

  return NextResponse.json({
    success: true,
    organizationId: org.id,
    organizationName: org.name,
  });
}

async function handleInvitation(userId: string, token: string) {
  // Find pending invitation with org relation
  const invitation = await db.query.teamInvitations.findFirst({
    where: and(
      eq(teamInvitations.token, token),
      eq(teamInvitations.status, "pending")
    ),
    with: {
      organization: true,
    },
  });

  if (!invitation) {
    return NextResponse.json(
      { error: "Invalid or expired invitation" },
      { status: 404 }
    );
  }

  // Check if expired
  if (new Date() > invitation.expiresAt) {
    await db
      .update(teamInvitations)
      .set({ status: "expired" })
      .where(eq(teamInvitations.id, invitation.id));

    return NextResponse.json(
      { error: "This invitation has expired" },
      { status: 410 }
    );
  }

  // Check if already a member
  const existing = await db.query.memberships.findFirst({
    where: and(
      eq(memberships.userId, userId),
      eq(memberships.organizationId, invitation.organizationId)
    ),
  });

  if (existing) {
    // Mark invitation as accepted since user is already a member
    await db
      .update(teamInvitations)
      .set({ status: "accepted" })
      .where(eq(teamInvitations.id, invitation.id));

    return NextResponse.json(
      { error: "You are already a member of this organization" },
      { status: 409 }
    );
  }

  // Create membership with invitation role
  await db.insert(memberships).values({
    userId,
    organizationId: invitation.organizationId,
    role: invitation.role,
  });

  // Mark invitation as accepted
  await db
    .update(teamInvitations)
    .set({ status: "accepted" })
    .where(eq(teamInvitations.id, invitation.id));

  await checkSecondMemberNudge(invitation.organizationId);

  return NextResponse.json({
    success: true,
    organizationId: invitation.organizationId,
    organizationName: invitation.organization.name,
  });
}
