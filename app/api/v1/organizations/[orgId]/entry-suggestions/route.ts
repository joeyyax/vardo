import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, sql, ilike } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

type DescriptionSuggestion = {
  description: string;
  client: {
    id: string;
    name: string;
    color: string | null;
  };
  project: {
    id: string;
    name: string;
    code: string | null;
  } | null;
  task: {
    id: string;
    name: string;
  } | null;
  durationMinutes: number;
  usageCount: number;
};

// GET /api/v1/organizations/[orgId]/entry-suggestions
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query")?.trim() || "";
    const clientIdFilter = searchParams.get("clientId");
    const projectIdFilter = searchParams.get("projectId");

    // Require at least 2 characters to search
    if (query.length < 2) {
      return NextResponse.json({ suggestions: [] });
    }

    const userId = session.user.id;

    // Calculate date 60 days ago
    const sixtyDaysAgo = new Date();
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
    const sixtyDaysAgoStr = sixtyDaysAgo.toISOString().split("T")[0];

    // Build conditions
    const conditions = [
      eq(timeEntries.organizationId, orgId),
      eq(timeEntries.userId, userId),
      gte(timeEntries.date, sixtyDaysAgoStr),
      ilike(timeEntries.description, `%${query}%`),
    ];

    if (clientIdFilter) {
      conditions.push(eq(timeEntries.clientId, clientIdFilter));
    }
    if (projectIdFilter) {
      conditions.push(eq(timeEntries.projectId, projectIdFilter));
    }

    // Query entries grouped by description + client + project + task
    // Calculate mode (most common) duration for each group
    const results = await db
      .select({
        description: timeEntries.description,
        clientId: timeEntries.clientId,
        projectId: timeEntries.projectId,
        taskId: timeEntries.taskId,
        usageCount: sql<number>`count(*)::int`,
        mostRecent: sql<string>`max(${timeEntries.date})`,
        // Get the most common duration using mode()
        durationMinutes: sql<number>`mode() within group (order by ${timeEntries.durationMinutes})`,
      })
      .from(timeEntries)
      .where(and(...conditions))
      .groupBy(
        timeEntries.description,
        timeEntries.clientId,
        timeEntries.projectId,
        timeEntries.taskId
      )
      .orderBy(
        sql`count(*) desc`,
        sql`max(${timeEntries.date}) desc`
      )
      .limit(10);

    // Fetch related entities
    const clientIds = [...new Set(results.map((r) => r.clientId))];
    const projectIds = [...new Set(results.map((r) => r.projectId).filter(Boolean))] as string[];
    const taskIds = [...new Set(results.map((r) => r.taskId).filter(Boolean))] as string[];

    const [clientsData, projectsData, tasksData] = await Promise.all([
      clientIds.length > 0
        ? db.query.clients.findMany({
            where: eq(clients.organizationId, orgId),
            columns: { id: true, name: true, color: true },
          })
        : [],
      projectIds.length > 0
        ? db.query.projects.findMany({
            columns: { id: true, name: true, code: true, clientId: true },
          })
        : [],
      taskIds.length > 0
        ? db.query.tasks.findMany({
            columns: { id: true, name: true, projectId: true },
          })
        : [],
    ]);

    const clientMap = new Map(clientsData.map((c) => [c.id, c]));
    const projectMap = new Map(projectsData.map((p) => [p.id, p]));
    const taskMap = new Map(tasksData.map((t) => [t.id, t]));

    // Build suggestions
    const suggestions: DescriptionSuggestion[] = results
      .filter((r) => r.description) // Only entries with descriptions
      .map((r) => {
        const client = clientMap.get(r.clientId);
        if (!client) return null;

        const project = r.projectId ? projectMap.get(r.projectId) : null;
        const task = r.taskId ? taskMap.get(r.taskId) : null;

        return {
          description: r.description!,
          client: {
            id: client.id,
            name: client.name,
            color: client.color,
          },
          project: project
            ? {
                id: project.id,
                name: project.name,
                code: project.code,
              }
            : null,
          task: task
            ? {
                id: task.id,
                name: task.name,
              }
            : null,
          durationMinutes: r.durationMinutes,
          usageCount: r.usageCount,
        };
      })
      .filter((s): s is DescriptionSuggestion => s !== null);

    return NextResponse.json({ suggestions });
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
    console.error("Error fetching entry suggestions:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
