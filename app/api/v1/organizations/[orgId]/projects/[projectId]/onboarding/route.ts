import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, onboardingItems } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, asc, inArray } from "drizzle-orm";
import { DEFAULT_ONBOARDING_ITEMS } from "@/lib/onboarding-templates";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
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

// GET — list onboarding items for a project
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectAccess(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const items = await db.query.onboardingItems.findMany({
      where: eq(onboardingItems.projectId, projectId),
      orderBy: [asc(onboardingItems.position)],
    });

    return NextResponse.json(items);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching onboarding items:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — initialize onboarding items from template (idempotent)
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectAccess(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Check if items already exist (idempotent)
    const existing = await db.query.onboardingItems.findMany({
      where: eq(onboardingItems.projectId, projectId),
      columns: { id: true },
    });

    if (existing.length > 0) {
      // Already initialized — return existing items
      const items = await db.query.onboardingItems.findMany({
        where: eq(onboardingItems.projectId, projectId),
        orderBy: [asc(onboardingItems.position)],
      });
      return NextResponse.json(items);
    }

    // Delta-based onboarding: pre-complete items done in previous projects for same client
    let previouslyCompleted: Set<string> = new Set();
    if (project.clientId) {
      const previousProjects = await db.query.projects.findMany({
        where: eq(projects.clientId, project.clientId),
        columns: { id: true },
      });
      const otherProjectIds = previousProjects
        .map((p) => p.id)
        .filter((id) => id !== projectId);

      if (otherProjectIds.length > 0) {
        const completedItems = await db.query.onboardingItems.findMany({
          where: and(
            inArray(onboardingItems.projectId, otherProjectIds),
            eq(onboardingItems.isCompleted, true)
          ),
          columns: { label: true },
        });
        previouslyCompleted = new Set(completedItems.map((i) => i.label));
      }
    }

    // Create from template
    const newItems = await db
      .insert(onboardingItems)
      .values(
        DEFAULT_ONBOARDING_ITEMS.map((item) => ({
          projectId,
          label: item.label,
          description: item.description,
          category: item.category,
          isRequired: item.isRequired,
          position: item.position,
          isCompleted: previouslyCompleted.has(item.label),
          completedAt: previouslyCompleted.has(item.label) ? new Date() : null,
        }))
      )
      .returning();

    return NextResponse.json(newItems, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error initializing onboarding items:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
