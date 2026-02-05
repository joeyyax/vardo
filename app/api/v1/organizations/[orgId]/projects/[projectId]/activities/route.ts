import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectActivities, projects, ACTIVITY_TYPES, type ActivityType } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, desc, and, lte, gte } from "drizzle-orm";
import { logActivity } from "@/lib/activity";

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

// GET /api/v1/organizations/[orgId]/projects/[projectId]/activities
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

    // Parse query params
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100);
    const offset = parseInt(searchParams.get("offset") || "0");
    const type = searchParams.get("type") as ActivityType | null;
    const before = searchParams.get("before"); // ISO date string
    const after = searchParams.get("after"); // ISO date string

    // Build conditions
    const conditions = [eq(projectActivities.projectId, projectId)];

    if (type && ACTIVITY_TYPES.includes(type)) {
      conditions.push(eq(projectActivities.type, type));
    }
    if (before) {
      conditions.push(lte(projectActivities.createdAt, new Date(before)));
    }
    if (after) {
      conditions.push(gte(projectActivities.createdAt, new Date(after)));
    }

    const activities = await db.query.projectActivities.findMany({
      where: and(...conditions),
      orderBy: [desc(projectActivities.createdAt)],
      limit,
      offset,
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

    return NextResponse.json(activities);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching activities:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/activities
// Create a note activity (other types are created automatically)
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
    const { content, isPublic } = body;

    // Validate content
    if (!content || typeof content !== "string" || !content.trim()) {
      return NextResponse.json({ error: "Content is required" }, { status: 400 });
    }

    // Create the note activity
    const activity = await logActivity({
      projectId,
      type: "note",
      actorId: session.user.id,
      actorType: "user",
      content: content.trim(),
      isPublic: isPublic === true,
    });

    if (!activity) {
      return NextResponse.json({ error: "Failed to create note" }, { status: 500 });
    }

    // Fetch with actor data
    const activityWithActor = await db.query.projectActivities.findFirst({
      where: eq(projectActivities.id, activity.id),
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

    return NextResponse.json(activityWithActor, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating note:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
