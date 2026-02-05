import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tasks, projects, clients, TASK_STATUSES, type TaskStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, inArray, isNull, isNotNull } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/tasks
// List all tasks across all projects in the organization
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get optional filters
    const { searchParams } = new URL(request.url);
    const clientId = searchParams.get("clientId");
    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");
    const assignedTo = searchParams.get("assignedTo");
    const includeArchived = searchParams.get("includeArchived") === "true";
    const hasStatus = searchParams.get("hasStatus"); // 'true' = only tasks with status, 'false' = only categories

    // First, get all projects in this org (through clients)
    const orgClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
      columns: { id: true },
    });

    const clientIds = orgClients.map((c) => c.id);

    if (clientIds.length === 0) {
      return NextResponse.json([]);
    }

    // Get projects, optionally filtered by client
    const projectConditions = [inArray(projects.clientId, clientIds)];
    if (clientId) {
      projectConditions.push(eq(projects.clientId, clientId));
    }

    const orgProjects = await db.query.projects.findMany({
      where: and(...projectConditions),
      columns: { id: true },
    });

    let projectIds = orgProjects.map((p) => p.id);

    // If filtering by specific project, narrow down
    if (projectId) {
      projectIds = projectIds.filter((id) => id === projectId);
    }

    if (projectIds.length === 0) {
      return NextResponse.json([]);
    }

    // Build task conditions
    const taskConditions = [inArray(tasks.projectId, projectIds)];

    if (!includeArchived) {
      taskConditions.push(eq(tasks.isArchived, false));
    }

    if (status && TASK_STATUSES.includes(status as TaskStatus)) {
      taskConditions.push(eq(tasks.status, status as TaskStatus));
    }

    if (assignedTo) {
      taskConditions.push(eq(tasks.assignedTo, assignedTo));
    }

    if (hasStatus === "true") {
      // Only tasks with a status (work items, not categories)
      taskConditions.push(isNotNull(tasks.status));
    } else if (hasStatus === "false") {
      // Only categories (no status)
      taskConditions.push(isNull(tasks.status));
    }

    const allTasks = await db.query.tasks.findMany({
      where: and(...taskConditions),
      with: {
        project: {
          columns: { id: true, name: true },
          with: {
            client: {
              columns: { id: true, name: true, color: true },
            },
          },
        },
        assignedToUser: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (tasks, { asc, desc }) => [
        asc(tasks.status),
        asc(tasks.position),
        desc(tasks.createdAt),
      ],
    });

    return NextResponse.json(allTasks);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching tasks:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
