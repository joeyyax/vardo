import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, taskRelationships, TASK_RELATIONSHIP_TYPES, type TaskRelationshipType } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, or } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; taskId: string }>;
};

async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: { client: true },
  });
  if (!project || project.client.organizationId !== orgId) {
    return null;
  }
  return project;
}

async function verifyTaskBelongsToProject(taskId: string, projectId: string) {
  return db.query.tasks.findFirst({
    where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
  });
}

// Check for circular dependencies when adding a blocker
async function wouldCreateCycle(sourceTaskId: string, targetTaskId: string): Promise<boolean> {
  // If adding "source blocked_by target", check if target is already blocked by source (directly or transitively)
  const visited = new Set<string>();
  const queue = [targetTaskId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (currentId === sourceTaskId) {
      return true; // Found a cycle
    }
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);

    // Get all tasks that this task is blocked by
    const blockers = await db.query.taskRelationships.findMany({
      where: and(
        eq(taskRelationships.sourceTaskId, currentId),
        eq(taskRelationships.type, "blocked_by")
      ),
    });

    for (const blocker of blockers) {
      queue.push(blocker.targetTaskId);
    }
  }

  return false;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/relationships
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const task = await verifyTaskBelongsToProject(taskId, projectId);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Get all relationships where this task is source or target
    const relationships = await db.query.taskRelationships.findMany({
      where: or(
        eq(taskRelationships.sourceTaskId, taskId),
        eq(taskRelationships.targetTaskId, taskId)
      ),
      with: {
        sourceTask: {
          columns: { id: true, name: true, status: true, projectId: true },
        },
        targetTask: {
          columns: { id: true, name: true, status: true, projectId: true },
        },
        createdByUser: {
          columns: { id: true, name: true, email: true },
        },
      },
    });

    // Organize by type and direction
    const blockedBy = relationships
      .filter((r) => r.sourceTaskId === taskId && r.type === "blocked_by")
      .map((r) => ({ ...r, task: r.targetTask }));

    const blocking = relationships
      .filter((r) => r.targetTaskId === taskId && r.type === "blocked_by")
      .map((r) => ({ ...r, task: r.sourceTask }));

    const relatedTo = relationships
      .filter((r) => r.sourceTaskId === taskId && r.type === "related_to")
      .map((r) => ({ ...r, task: r.targetTask }));

    const relatedFrom = relationships
      .filter((r) => r.targetTaskId === taskId && r.type === "related_to")
      .map((r) => ({ ...r, task: r.sourceTask }));

    return NextResponse.json({
      blockedBy,      // Tasks blocking this one
      blocking,       // Tasks this one blocks
      relatedTo,      // Tasks this one is related to
      relatedFrom,    // Tasks related to this one
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching relationships:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/tasks/[taskId]/relationships
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, taskId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const task = await verifyTaskBelongsToProject(taskId, projectId);
    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const body = await request.json();
    const { targetTaskId, type } = body;

    if (!targetTaskId) {
      return NextResponse.json({ error: "targetTaskId is required" }, { status: 400 });
    }

    if (!type || !TASK_RELATIONSHIP_TYPES.includes(type as TaskRelationshipType)) {
      return NextResponse.json(
        { error: `type must be one of: ${TASK_RELATIONSHIP_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    if (targetTaskId === taskId) {
      return NextResponse.json({ error: "Cannot relate a task to itself" }, { status: 400 });
    }

    // Verify target task exists (can be in any project within the org)
    const targetTask = await db.query.tasks.findFirst({
      where: eq(tasks.id, targetTaskId),
      with: {
        project: {
          with: { client: true },
        },
      },
    });

    if (!targetTask || targetTask.project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Target task not found" }, { status: 404 });
    }

    // Check for circular dependency if adding a blocker
    if (type === "blocked_by") {
      const wouldCycle = await wouldCreateCycle(taskId, targetTaskId);
      if (wouldCycle) {
        return NextResponse.json(
          { error: "Cannot add blocker: would create circular dependency" },
          { status: 400 }
        );
      }
    }

    // Check if relationship already exists
    const existing = await db.query.taskRelationships.findFirst({
      where: and(
        eq(taskRelationships.sourceTaskId, taskId),
        eq(taskRelationships.targetTaskId, targetTaskId),
        eq(taskRelationships.type, type as TaskRelationshipType)
      ),
    });

    if (existing) {
      return NextResponse.json({ error: "Relationship already exists" }, { status: 409 });
    }

    const [relationship] = await db
      .insert(taskRelationships)
      .values({
        sourceTaskId: taskId,
        targetTaskId,
        type: type as TaskRelationshipType,
        createdBy: session.user.id,
      })
      .returning();

    return NextResponse.json(relationship, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating relationship:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
