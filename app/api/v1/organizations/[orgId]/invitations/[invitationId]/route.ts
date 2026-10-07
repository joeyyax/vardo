import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { invitations, user } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { sendEmail, emailDelivery } from "@/lib/email/send";
import { InviteEmail } from "@/lib/email/templates/invite";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requirePlugin } from "@/lib/api/require-plugin";
import { generateInvitationToken, invitationUrl } from "@/lib/invitations/token";

import { withRateLimit } from "@/lib/api/with-rate-limit";

type RouteParams = {
  params: Promise<{ orgId: string; invitationId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/invitations/[invitationId]
// Revokes a pending invitation
async function handleDelete(
  _request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { orgId, invitationId } = await params;
    const org = await verifyOrgAccess(orgId, "org.members.manage");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("teams");
    if (gate) return gate;

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
      .set({ status: "revoked" })
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
// Issue a new link, replacing the old one, and email it unless `send` is false
async function handlePatch(
  request: NextRequest,
  { params }: RouteParams
) {
  try {
    const { orgId, invitationId } = await params;
    const org = await verifyOrgAccess(orgId, "org.members.manage");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("teams");
    if (gate) return gate;

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

    const body = await request.json().catch(() => ({}));
    const send = (body as { send?: unknown } | null)?.send !== false;

    // Only the hash is stored, so a link can't be shown again; issue a new one.
    const token = generateInvitationToken();
    const [rotated] = await db
      .update(invitations)
      .set({ tokenHash: token.hash })
      .where(and(eq(invitations.id, invitation.id), eq(invitations.status, "pending")))
      .returning({ id: invitations.id });
    if (!rotated) {
      return NextResponse.json(
        { error: "Only pending invitations can be resent" },
        { status: 400 }
      );
    }
    const inviteUrl = invitationUrl(token.raw);

    if (!send) return NextResponse.json({ success: true, inviteUrl });

    const inviter = await db.query.user.findFirst({
      where: eq(user.id, org.session.user.id),
      columns: { name: true },
    });

    const sent = await sendEmail({
      to: invitation.email,
      subject: `You've been invited to ${org.organization.name}`,
      template: InviteEmail({
        email: invitation.email,
        orgName: org.organization.name,
        inviterName: inviter?.name ?? undefined,
        inviteUrl,
      }),
    });

    return NextResponse.json({ success: true, inviteUrl, email: emailDelivery(sent) });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error resending invitation");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "organizations-invitations" });
export const PATCH = withRateLimit(handlePatch, { tier: "mutation", key: "organizations-invitations" });
