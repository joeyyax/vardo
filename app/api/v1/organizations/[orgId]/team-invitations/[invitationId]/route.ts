import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teamInvitations } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { sendEmail } from "@/lib/email/send";
import { teamInvitationEmail } from "@/lib/email/team-invitation-email";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; invitationId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/team-invitations/[invitationId]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const deleted = await db
      .delete(teamInvitations)
      .where(
        and(
          eq(teamInvitations.id, invitationId),
          eq(teamInvitations.organizationId, orgId)
        )
      )
      .returning();

    if (deleted.length === 0) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error revoking team invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/team-invitations/[invitationId]
// Resend invitation email
export async function POST(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, invitationId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const invitation = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.id, invitationId),
        eq(teamInvitations.organizationId, orgId),
        eq(teamInvitations.status, "pending")
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    // Resend the email
    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/invitations/team/${invitation.token}`;

    await sendEmail(
      {
        ...teamInvitationEmail({
          organizationName: organization.name,
          invitedByName: session.user.name || session.user.email,
          inviteUrl,
          role: invitation.role,
        }),
        to: invitation.email,
      },
      {
        organizationId: orgId,
        entityType: "invitation",
        entityId: invitation.id,
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error resending team invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
