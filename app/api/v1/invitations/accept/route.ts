import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { invitations, memberships } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const acceptSchema = z.object({ token: z.string().min(1, "Token is required") }).strict();

// POST /api/v1/invitations/accept
// Accept an invitation by token
async function handlePost(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }
    const { token } = parsed.data;

    const invitation = await db.query.invitations.findFirst({
      where: eq(invitations.token, token),
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

    // Check if there's a logged-in user
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }

    // User is logged in — verify email matches
    if (session.user.email !== invitation.email) {
      return NextResponse.json(
        {
          error: "This invitation was sent to a different email address",
          invitedEmail: invitation.email,
        },
        { status: 403 }
      );
    }

    // Accept the invitation
    if (invitation.scope === "org" && invitation.targetId) {
      // Check if already a member
      const existingMembership = await db.query.memberships.findFirst({
        where: and(
          eq(memberships.organizationId, invitation.targetId),
          eq(memberships.userId, session.user.id),
        ),
      });

      if (!existingMembership) {
        await db.insert(memberships).values({
          id: nanoid(),
          userId: session.user.id,
          organizationId: invitation.targetId,
          role: invitation.role,
        });
      }
    }

    await db
      .update(invitations)
      .set({
        status: "accepted",
        acceptedAt: new Date(),
      })
      .where(eq(invitations.id, invitation.id));

    return NextResponse.json({
      success: true,
      orgId: invitation.scope === "org" ? invitation.targetId : null,
    });
  } catch (error) {
    return handleRouteError(error, "Error accepting invitation");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "invitations-accept" });
