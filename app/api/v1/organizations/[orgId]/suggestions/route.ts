import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, tasks, projects, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, inArray, sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

type SuggestionReason = "recent" | "frequent" | "match";

type Suggestion = {
  task: {
    id: string;
    name: string;
  };
  project: {
    id: string;
    name: string;
    code: string | null;
  };
  client: {
    id: string;
    name: string;
    color: string | null;
  };
  score: number;
  reason: SuggestionReason;
};

// GET /api/v1/organizations/[orgId]/suggestions
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("query")?.trim().toLowerCase() || "";
    const limit = Math.min(
      Math.max(parseInt(searchParams.get("limit") || "10", 10), 1),
      50
    );

    const userId = session.user.id;

    // Calculate date 14 days ago
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const fourteenDaysAgoStr = fourteenDaysAgo.toISOString().split("T")[0];

    // Get user's recent time entries grouped by taskId with frequency and most recent date
    // This query gets: taskId, count of entries, most recent entry date
    const recentUsage = await db
      .select({
        taskId: timeEntries.taskId,
        frequency: sql<number>`count(*)::int`,
        mostRecent: sql<string>`max(${timeEntries.date})`,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.organizationId, orgId),
          eq(timeEntries.userId, userId),
          gte(timeEntries.date, fourteenDaysAgoStr)
        )
      )
      .groupBy(timeEntries.taskId);

    // If no recent usage and no query, return empty suggestions
    if (recentUsage.length === 0 && !query) {
      return NextResponse.json({ suggestions: [] });
    }

    // Build a map for quick lookup of usage stats
    const usageMap = new Map(
      recentUsage.map((r) => [
        r.taskId,
        { frequency: r.frequency, mostRecent: r.mostRecent },
      ])
    );

    // Get all clients for this org (needed for filtering)
    const orgClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
      columns: { id: true, name: true, color: true },
    });
    const orgClientIds = orgClients.map((c) => c.id);
    const clientMap = new Map(orgClients.map((c) => [c.id, c]));

    if (orgClientIds.length === 0) {
      return NextResponse.json({ suggestions: [] });
    }

    // Get non-archived projects for this org
    const orgProjects = await db.query.projects.findMany({
      where: and(
        inArray(projects.clientId, orgClientIds),
        eq(projects.isArchived, false)
      ),
      columns: { id: true, name: true, code: true, clientId: true },
    });
    const projectIds = orgProjects.map((p) => p.id);
    const projectMap = new Map(orgProjects.map((p) => [p.id, p]));

    if (projectIds.length === 0) {
      return NextResponse.json({ suggestions: [] });
    }

    // Get non-archived tasks from non-archived projects
    const orgTasks = await db.query.tasks.findMany({
      where: and(
        inArray(tasks.projectId, projectIds),
        eq(tasks.isArchived, false)
      ),
      columns: { id: true, name: true, projectId: true },
    });

    // Score and filter tasks
    const today = new Date();
    const suggestions: Suggestion[] = [];

    for (const task of orgTasks) {
      const project = projectMap.get(task.projectId);
      if (!project) continue;

      const client = clientMap.get(project.clientId);
      if (!client) continue;

      const usage = usageMap.get(task.id);

      // Calculate score
      let score = 0;
      let reason: SuggestionReason = "match";

      if (usage) {
        // Recency score: days since last use (0-14), inverted so recent = higher
        const daysSince = Math.floor(
          (today.getTime() - new Date(usage.mostRecent).getTime()) /
            (1000 * 60 * 60 * 24)
        );
        const recencyScore = Math.max(0, 14 - daysSince) * 10; // 0-140

        // Frequency score: capped at 20 entries
        const frequencyScore = Math.min(usage.frequency, 20) * 5; // 0-100

        score = recencyScore + frequencyScore;

        // Determine primary reason
        if (daysSince <= 3) {
          reason = "recent";
        } else if (usage.frequency >= 3) {
          reason = "frequent";
        } else {
          reason = "recent";
        }
      }

      // If query provided, filter and boost matches
      if (query) {
        const taskNameLower = task.name.toLowerCase();
        const projectNameLower = project.name.toLowerCase();
        const clientNameLower = client.name.toLowerCase();
        const projectCodeLower = project.code?.toLowerCase() || "";

        const matches =
          taskNameLower.includes(query) ||
          projectNameLower.includes(query) ||
          clientNameLower.includes(query) ||
          projectCodeLower.includes(query);

        if (!matches) {
          continue; // Skip non-matching tasks when query is provided
        }

        // Boost score for text matches
        if (taskNameLower.startsWith(query)) {
          score += 50;
        } else if (taskNameLower.includes(query)) {
          score += 30;
        }

        if (projectNameLower.startsWith(query)) {
          score += 40;
        } else if (projectNameLower.includes(query)) {
          score += 20;
        }

        if (clientNameLower.startsWith(query)) {
          score += 30;
        } else if (clientNameLower.includes(query)) {
          score += 15;
        }

        if (projectCodeLower && projectCodeLower.includes(query)) {
          score += 25;
        }

        // If no recent usage but matches query, set reason to match
        if (!usage) {
          reason = "match";
          score = Math.max(score, 10); // Minimum score for matches
        }
      } else {
        // No query provided - only include tasks with recent usage
        if (!usage) {
          continue;
        }
      }

      suggestions.push({
        task: {
          id: task.id,
          name: task.name,
        },
        project: {
          id: project.id,
          name: project.name,
          code: project.code,
        },
        client: {
          id: client.id,
          name: client.name,
          color: client.color,
        },
        score,
        reason,
      });
    }

    // Sort by score descending and limit results
    suggestions.sort((a, b) => b.score - a.score);
    const limitedSuggestions = suggestions.slice(0, limit);

    return NextResponse.json({ suggestions: limitedSuggestions });
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
    console.error("Error fetching suggestions:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
