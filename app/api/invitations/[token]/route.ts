import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectInvitations, projects } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { logInvitationAccepted } from "@/lib/activity";
import {
  checkPublicRateLimit,
  isValidToken,
  logSecurityEvent,
} from "@/lib/security";

type RouteParams = {
  params: Promise<{ token: string }>;
};

// GET /api/invitations/[token]
// Public endpoint to view invitation details before accepting
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { token } = await params;

    // Validate token format
    if (!isValidToken(token)) {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    // Rate limiting
    const rateLimit = await checkPublicRateLimit();
    if (!rateLimit.allowed) {
      await logSecurityEvent("rate_limit_exceeded", { endpoint: "invitation_view", token: token.slice(0, 8) });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    const invitation = await db.query.projectInvitations.findFirst({
      where: eq(projectInvitations.token, token),
      with: {
        project: {
          with: {
            client: {
              with: {
                organization: {
                  columns: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found or expired" }, { status: 404 });
    }

    // Mark as viewed if not already
    if (!invitation.viewedAt) {
      await db
        .update(projectInvitations)
        .set({ viewedAt: new Date() })
        .where(eq(projectInvitations.id, invitation.id));
    }

    // Return limited info (don't expose sensitive details)
    return NextResponse.json({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      accepted: !!invitation.acceptedAt,
      project: {
        id: invitation.project.id,
        name: invitation.project.name,
      },
      organization: {
        id: invitation.project.client.organization.id,
        name: invitation.project.client.organization.name,
      },
    });
  } catch (error) {
    console.error("Error fetching invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/invitations/[token]
// Accept the invitation (requires authenticated user)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { token } = await params;

    // Validate token format
    if (!isValidToken(token)) {
      return NextResponse.json({ error: "Invalid token" }, { status: 400 });
    }

    // Rate limiting
    const rateLimit = await checkPublicRateLimit();
    if (!rateLimit.allowed) {
      await logSecurityEvent("rate_limit_exceeded", { endpoint: "invitation_accept", token: token.slice(0, 8) });
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        { status: 429 }
      );
    }

    // Check if user is logged in
    const session = await getSession();

    const invitation = await db.query.projectInvitations.findFirst({
      where: eq(projectInvitations.token, token),
      with: {
        project: true,
      },
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found or expired" }, { status: 404 });
    }

    if (invitation.acceptedAt) {
      return NextResponse.json({ error: "Invitation already accepted" }, { status: 400 });
    }

    if (!session) {
      // User needs to authenticate first
      return NextResponse.json({
        requiresAuth: true,
        email: invitation.email,
        projectName: invitation.project.name,
      });
    }

    // Verify the email matches (optional - could allow any authenticated user)
    // For now, we'll allow any authenticated user to accept if they have the link
    // The invitation email is just for reference

    // Accept the invitation
    const [updated] = await db
      .update(projectInvitations)
      .set({
        acceptedAt: new Date(),
        userId: session.user.id,
      })
      .where(eq(projectInvitations.id, invitation.id))
      .returning();

    // Log the activity
    await logInvitationAccepted({
      projectId: invitation.projectId,
      actorId: session.user.id,
      invitationId: invitation.id,
      inviteeEmail: invitation.email,
    });

    // Security audit log
    await logSecurityEvent("invitation_accepted", {
      invitationId: invitation.id,
      projectId: invitation.projectId,
      inviteeEmail: invitation.email,
      acceptedByUserId: session.user.id,
    });

    return NextResponse.json({
      success: true,
      projectId: invitation.projectId,
      invitation: updated,
    });
  } catch (error) {
    console.error("Error accepting invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
