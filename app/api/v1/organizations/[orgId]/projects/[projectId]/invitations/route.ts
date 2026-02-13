import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectInvitations, projects, INVITATION_ROLES, DEFAULT_INVITATION_VISIBILITY, type InvitationRole, type InvitationVisibility } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logInvitationSent } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

/**
 * Verify that the project belongs to the organization.
 */
async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/invitations
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const invitations = await db.query.projectInvitations.findMany({
      where: eq(projectInvitations.projectId, projectId),
      orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    });

    return NextResponse.json(invitations);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching invitations:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/invitations
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { email, role, visibility } = body;

    // Validate email
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Validate role
    const invitationRole: InvitationRole = INVITATION_ROLES.includes(role) ? role : "viewer";

    // Merge visibility with defaults
    const invitationVisibility: InvitationVisibility = {
      ...DEFAULT_INVITATION_VISIBILITY,
      ...(visibility && typeof visibility === "object" ? visibility : {}),
    };

    // Check if invitation already exists for this email/project
    const existingInvitation = await db.query.projectInvitations.findFirst({
      where: and(
        eq(projectInvitations.projectId, projectId),
        eq(projectInvitations.email, normalizedEmail)
      ),
    });

    if (existingInvitation) {
      // Update existing invitation
      const [updated] = await db
        .update(projectInvitations)
        .set({
          role: invitationRole,
          visibility: invitationVisibility,
          invitedBy: session.user.id,
          token: nanoid(32), // Generate new token
          sentAt: null, // Reset sent status
          acceptedAt: null,
          userId: null,
        })
        .where(eq(projectInvitations.id, existingInvitation.id))
        .returning();

      // TODO: Send invitation email via MailPace

      return NextResponse.json(updated);
    }

    // Create new invitation
    const token = nanoid(32);

    const [invitation] = await db
      .insert(projectInvitations)
      .values({
        projectId,
        email: normalizedEmail,
        role: invitationRole,
        visibility: invitationVisibility,
        invitedBy: session.user.id,
        token,
      })
      .returning();

    // Log the activity
    await logInvitationSent({
      projectId,
      actorId: session.user.id,
      invitationId: invitation.id,
      inviteeEmail: normalizedEmail,
      inviteeRole: invitationRole,
    });

    // TODO: Send invitation email via MailPace
    // For now, just mark as sent
    await db
      .update(projectInvitations)
      .set({ sentAt: new Date() })
      .where(eq(projectInvitations.id, invitation.id));

    return NextResponse.json({ ...invitation, sentAt: new Date() }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
