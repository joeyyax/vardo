import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectActivities, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; activityId: string }>;
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

// GET /api/v1/organizations/[orgId]/projects/[projectId]/activities/[activityId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, activityId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const activity = await db.query.projectActivities.findFirst({
      where: and(
        eq(projectActivities.id, activityId),
        eq(projectActivities.projectId, projectId)
      ),
      with: {
        actor: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    if (!activity) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }

    return NextResponse.json(activity);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching activity:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/projects/[projectId]/activities/[activityId]
// Update a note (only notes can be updated)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, activityId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const activity = await db.query.projectActivities.findFirst({
      where: and(
        eq(projectActivities.id, activityId),
        eq(projectActivities.projectId, projectId)
      ),
    });

    if (!activity) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }

    // Only notes can be updated
    if (activity.type !== "note") {
      return NextResponse.json(
        { error: "Only notes can be updated" },
        { status: 400 }
      );
    }

    // Only the author can update their own notes
    if (activity.actorId !== session.user.id) {
      return NextResponse.json(
        { error: "You can only edit your own notes" },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { content, isPublic } = body;

    const updateData: Record<string, unknown> = {};

    if (content !== undefined) {
      if (!content || typeof content !== "string" || !content.trim()) {
        return NextResponse.json({ error: "Content is required" }, { status: 400 });
      }
      updateData.content = content.trim();
    }

    if (typeof isPublic === "boolean") {
      updateData.isPublic = isPublic;
    }

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const [updated] = await db
      .update(projectActivities)
      .set(updateData)
      .where(eq(projectActivities.id, activityId))
      .returning();

    // Fetch with actor data
    const activityWithActor = await db.query.projectActivities.findFirst({
      where: eq(projectActivities.id, updated.id),
      with: {
        actor: {
          columns: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
    });

    return NextResponse.json(activityWithActor);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating activity:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/activities/[activityId]
// Delete a note (only notes can be deleted)
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, activityId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const activity = await db.query.projectActivities.findFirst({
      where: and(
        eq(projectActivities.id, activityId),
        eq(projectActivities.projectId, projectId)
      ),
    });

    if (!activity) {
      return NextResponse.json({ error: "Activity not found" }, { status: 404 });
    }

    // Only notes can be deleted
    if (activity.type !== "note") {
      return NextResponse.json(
        { error: "Only notes can be deleted" },
        { status: 400 }
      );
    }

    // Only the author can delete their own notes
    if (activity.actorId !== session.user.id) {
      return NextResponse.json(
        { error: "You can only delete your own notes" },
        { status: 403 }
      );
    }

    await db.delete(projectActivities).where(eq(projectActivities.id, activityId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error deleting activity:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
