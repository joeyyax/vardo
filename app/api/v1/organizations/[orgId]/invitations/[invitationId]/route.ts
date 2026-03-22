import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { invitations, user } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { sendEmail } from "@/lib/email/send";
import { InviteEmail } from "@/lib/email/templates/invite";

type RouteParams = {
  params: Promise<{ orgId: string; invitationId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/invitations/[invitationId]
// Revoke/cancel a pending invitation
export async function DELETE(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { orgId, invitationId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const invitation = await db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.targetId, orgId),
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    if (invitation.status !== "pending") {
      return NextResponse.json(
        { error: "Only pending invitations can be revoked" },
        { status: 400 }
      );
    }

    await db
      .update(invitations)
      .set({ status: "expired" })
      .where(eq(invitations.id, invitationId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error revoking invitation");
  }
}

// PATCH /api/v1/organizations/[orgId]/invitations/[invitationId]
// Resend invitation email
export async function PATCH(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { orgId, invitationId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const invitation = await db.query.invitations.findFirst({
      where: and(
        eq(invitations.id, invitationId),
        eq(invitations.targetId, orgId),
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    if (invitation.status !== "pending") {
      return NextResponse.json(
        { error: "Only pending invitations can be resent" },
        { status: 400 }
      );
    }

    const inviter = await db.query.user.findFirst({
      where: eq(user.id, session.user.id),
      columns: { name: true },
    });

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const inviteUrl = `${appUrl}/invite/${invitation.token}`;

    await sendEmail({
      to: invitation.email,
      subject: `You've been invited to ${organization.name}`,
      template: InviteEmail({
        email: invitation.email,
        orgName: organization.name,
        inviterName: inviter?.name ?? undefined,
        inviteUrl,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error resending invitation");
  }
}
