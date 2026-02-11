import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, onboardingItems } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; itemId: string }>;
};

async function verifyProjectAccess(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: { columns: { organizationId: true } },
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }
  return project;
}

// PATCH — toggle item completion
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, itemId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectAccess(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Get the item
    const item = await db.query.onboardingItems.findFirst({
      where: and(
        eq(onboardingItems.id, itemId),
        eq(onboardingItems.projectId, projectId)
      ),
    });

    if (!item) {
      return NextResponse.json({ error: "Item not found" }, { status: 404 });
    }

    const body = await request.json();
    const isCompleted = body.isCompleted ?? !item.isCompleted;

    const [updated] = await db
      .update(onboardingItems)
      .set({
        isCompleted,
        completedAt: isCompleted ? new Date() : null,
        completedBy: isCompleted ? session.user.id : null,
      })
      .where(
        and(
          eq(onboardingItems.id, itemId),
          eq(onboardingItems.projectId, projectId)
        )
      )
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating onboarding item:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
