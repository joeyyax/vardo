import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectInvitations, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; invitationId: string }>;
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

// GET /api/v1/organizations/[orgId]/projects/[projectId]/invitations/[invitationId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, invitationId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const invitation = await db.query.projectInvitations.findFirst({
      where: and(
        eq(projectInvitations.id, invitationId),
        eq(projectInvitations.projectId, projectId)
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    return NextResponse.json(invitation);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/invitations/[invitationId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, invitationId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Verify invitation exists and belongs to this project
    const invitation = await db.query.projectInvitations.findFirst({
      where: and(
        eq(projectInvitations.id, invitationId),
        eq(projectInvitations.projectId, projectId)
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    // Delete the invitation
    await db
      .delete(projectInvitations)
      .where(eq(projectInvitations.id, invitationId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error deleting invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/invitations/[invitationId]
// Used for resending invitations or updating role/visibility
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, invitationId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Verify invitation exists and belongs to this project
    const invitation = await db.query.projectInvitations.findFirst({
      where: and(
        eq(projectInvitations.id, invitationId),
        eq(projectInvitations.projectId, projectId)
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    const body = await request.json();
    const { role, visibility, resend } = body;

    const updateData: Record<string, unknown> = {};

    if (role !== undefined) {
      updateData.role = role;
    }

    if (visibility !== undefined) {
      updateData.visibility = {
        ...invitation.visibility,
        ...visibility,
      };
    }

    if (resend) {
      // Reset sent status to trigger a new email
      updateData.sentAt = null;
      updateData.invitedBy = session.user.id;
    }

    const [updated] = await db
      .update(projectInvitations)
      .set(updateData)
      .where(eq(projectInvitations.id, invitationId))
      .returning();

    // TODO: If resend is true, send invitation email via MailPace

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
