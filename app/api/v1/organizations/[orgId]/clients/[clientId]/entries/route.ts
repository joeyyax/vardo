import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, clients, projects, tasks } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
};

// GET /api/v1/organizations/[orgId]/clients/[clientId]/entries
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify client belongs to org
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get("limit") || "10", 10);

    // Get recent entries for this client
    const entries = await db
      .select({
        id: timeEntries.id,
        date: timeEntries.date,
        description: timeEntries.description,
        durationMinutes: timeEntries.durationMinutes,
        projectId: timeEntries.projectId,
        projectName: projects.name,
        taskId: timeEntries.taskId,
        taskName: tasks.name,
      })
      .from(timeEntries)
      .leftJoin(projects, eq(timeEntries.projectId, projects.id))
      .leftJoin(tasks, eq(timeEntries.taskId, tasks.id))
      .where(
        and(
          eq(timeEntries.clientId, clientId),
          eq(timeEntries.organizationId, orgId)
        )
      )
      .orderBy(desc(timeEntries.date), desc(timeEntries.createdAt))
      .limit(limit);

    const formattedEntries = entries.map((entry) => ({
      id: entry.id,
      date: entry.date,
      description: entry.description,
      durationMinutes: entry.durationMinutes,
      project: entry.projectId
        ? { id: entry.projectId, name: entry.projectName! }
        : null,
      task: entry.taskId ? { id: entry.taskId, name: entry.taskName! } : null,
    }));

    return NextResponse.json({ entries: formattedEntries });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching client entries:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
