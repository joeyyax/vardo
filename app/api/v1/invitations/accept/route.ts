import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { invitations } from "@/lib/db/schema";
import { getSession, isScopedToken } from "@/lib/auth/session";
import { requirePlugin } from "@/lib/api/require-plugin";
import { eq } from "drizzle-orm";
import { hashInvitationToken } from "@/lib/invitations/token";
import { claimInvitation } from "@/lib/invitations/accept";
import { SYSTEM_ORG_MEMBERS_ONLY_ADMINS } from "@/lib/auth/system-org";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const acceptSchema = z.object({ token: z.string().min(1, "Token is required") }).strict();

// POST /api/v1/invitations/accept — accept an invitation by token
async function handlePost(request: NextRequest) {
  try {
    const gate = await requirePlugin("teams");
    if (gate) return gate;

    const body = await request.json();
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }
    const { token } = parsed.data;

    const invitation = await db.query.invitations.findFirst({
      where: eq(invitations.tokenHash, hashInvitationToken(token)),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invalid invitation token" }, { status: 404 });
    }

    if (invitation.status === "accepted") {
      return NextResponse.json({ error: "Invitation already accepted" }, { status: 409 });
    }

    if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
      // Mark as expired if not already
      if (invitation.status !== "expired") {
        await db
          .update(invitations)
          .set({ status: "expired" })
          .where(eq(invitations.id, invitation.id));
      }
      return NextResponse.json({ error: "Invitation has expired" }, { status: 410 });
    }

    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }
    // A scoped token only acts through org capabilities.
    if (isScopedToken(session)) return apiError.forbidden();

    // A logged-in user's email must match.
    if (session.user.email !== invitation.email) {
      return NextResponse.json(
        {
          error: "This invitation was sent to a different email address",
          invitedEmail: invitation.email,
        },
        { status: 403 }
      );
    }

    const claim = await claimInvitation(invitation, session.user.id);
    if (claim === "not-allowed") {
      return NextResponse.json({ error: SYSTEM_ORG_MEMBERS_ONLY_ADMINS }, { status: 403 });
    }
    if (claim === "invalid") {
      return NextResponse.json({ error: "This invitation is no longer valid" }, { status: 410 });
    }

    return NextResponse.json({
      success: true,
      orgId: invitation.scope === "org" ? invitation.targetId : null,
    });
  } catch (error) {
    return handleRouteError(error, "Error accepting invitation");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "invitations-accept" });
