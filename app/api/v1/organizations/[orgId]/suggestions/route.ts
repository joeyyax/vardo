import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, tasks, projects, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

type SuggestionReason = "recent" | "frequent" | "match";

/**
 * Suggestion type for flexible hierarchy.
 * Can represent:
 * - Client only (project and task are null)
 * - Client + Project (task is null)
 * - Client + Project + Task (full hierarchy)
 */
type Suggestion = {
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
  score: number;
  reason: SuggestionReason;
  // Unique key for deduplication
  key: string;
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
      Math.max(parseInt(searchParams.get("limit") || "15", 10), 1),
      50
    );

    const userId = session.user.id;

    // Calculate date 14 days ago
    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);
    const fourteenDaysAgoStr = fourteenDaysAgo.toISOString().split("T")[0];

    // Get user's recent time entries with usage stats at each level
    // This aggregates by the combination of clientId, projectId, taskId
    const recentUsage = await db
      .select({
        clientId: timeEntries.clientId,
        projectId: timeEntries.projectId,
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
      .groupBy(timeEntries.clientId, timeEntries.projectId, timeEntries.taskId);

    // Build a map for quick lookup of usage stats
    // Key format: clientId|projectId|taskId (null represented as "")
    const usageMap = new Map(
      recentUsage.map((r) => [
        `${r.clientId}|${r.projectId || ""}|${r.taskId || ""}`,
        { frequency: r.frequency, mostRecent: r.mostRecent },
      ])
    );

    // Get all clients for this org
    const orgClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
      columns: { id: true, name: true, color: true },
    });
    const clientMap = new Map(orgClients.map((c) => [c.id, c]));

    if (orgClients.length === 0) {
      return NextResponse.json({ suggestions: [] });
    }

    // Get all non-archived projects for this org
    const orgProjects = await db.query.projects.findMany({
      where: eq(projects.isArchived, false),
    });
    // Filter to only projects belonging to org's clients
    const orgClientIds = new Set(orgClients.map((c) => c.id));
    const validProjects = orgProjects.filter((p) => orgClientIds.has(p.clientId));
    const projectMap = new Map(validProjects.map((p) => [p.id, p]));

    // Get all non-archived tasks from valid projects
    const projectIds = validProjects.map((p) => p.id);
    const orgTasks = projectIds.length > 0
      ? await db.query.tasks.findMany({
          where: eq(tasks.isArchived, false),
        })
      : [];
    const validTasks = orgTasks.filter((t) => projectMap.has(t.projectId));
    const taskMap = new Map(validTasks.map((t) => [t.id, t]));

    // Build sets for quick lookup
    const projectIdsWithTasks = new Set(validTasks.map((t) => t.projectId));
    const clientIdsWithProjects = new Set(validProjects.map((p) => p.clientId));

    const today = new Date();
    const suggestionsMap = new Map<string, Suggestion>();

    // Helper to calculate score and reason
    const calculateScoreAndReason = (
      usageKey: string
    ): { score: number; reason: SuggestionReason } => {
      const usage = usageMap.get(usageKey);
      if (!usage) {
        return { score: 0, reason: "match" };
      }

      const daysSince = Math.floor(
        (today.getTime() - new Date(usage.mostRecent).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      const recencyScore = Math.max(0, 14 - daysSince) * 10; // 0-140
      const frequencyScore = Math.min(usage.frequency, 20) * 5; // 0-100
      const score = recencyScore + frequencyScore;

      let reason: SuggestionReason;
      if (daysSince <= 3) {
        reason = "recent";
      } else if (usage.frequency >= 3) {
        reason = "frequent";
      } else {
        reason = "recent";
      }

      return { score, reason };
    };

    // Helper to check text match and boost score
    const getMatchBoost = (
      query: string,
      clientName: string,
      projectName?: string | null,
      projectCode?: string | null,
      taskName?: string | null
    ): { matches: boolean; boost: number } => {
      if (!query) return { matches: true, boost: 0 };

      const clientLower = clientName.toLowerCase();
      const projectLower = projectName?.toLowerCase() || "";
      const codeLower = projectCode?.toLowerCase() || "";
      const taskLower = taskName?.toLowerCase() || "";

      const matches =
        clientLower.includes(query) ||
        projectLower.includes(query) ||
        codeLower.includes(query) ||
        taskLower.includes(query);

      if (!matches) return { matches: false, boost: 0 };

      let boost = 0;

      if (taskLower.startsWith(query)) boost += 50;
      else if (taskLower.includes(query)) boost += 30;

      if (projectLower.startsWith(query)) boost += 40;
      else if (projectLower.includes(query)) boost += 20;

      if (clientLower.startsWith(query)) boost += 30;
      else if (clientLower.includes(query)) boost += 15;

      if (codeLower && codeLower.includes(query)) boost += 25;

      return { matches: true, boost };
    };

    // Add task-level suggestions (full hierarchy)
    for (const task of validTasks) {
      const project = projectMap.get(task.projectId);
      if (!project) continue;
      const client = clientMap.get(project.clientId);
      if (!client) continue;

      const usageKey = `${client.id}|${project.id}|${task.id}`;
      const { score: baseScore, reason } = calculateScoreAndReason(usageKey);
      const { matches, boost } = getMatchBoost(
        query,
        client.name,
        project.name,
        project.code,
        task.name
      );

      // When query is provided: include matching items (even without usage history)
      // When no query: only show items with recent usage
      if (query && !matches) continue;
      if (!query && baseScore === 0) continue;

      // Boost untracked items that match the query so they still appear
      const score = baseScore + boost + (query && baseScore === 0 ? 10 : 0);
      const key = usageKey;

      suggestionsMap.set(key, {
        client: { id: client.id, name: client.name, color: client.color },
        project: { id: project.id, name: project.name, code: project.code },
        task: { id: task.id, name: task.name },
        score,
        reason: baseScore === 0 ? "match" : reason,
        key,
      });
    }

    // Add project-level suggestions (client + project, no task)
    for (const project of validProjects) {
      const client = clientMap.get(project.clientId);
      if (!client) continue;

      const usageKey = `${client.id}|${project.id}|`;
      const { score: baseScore, reason } = calculateScoreAndReason(usageKey);
      const { matches, boost } = getMatchBoost(
        query,
        client.name,
        project.name,
        project.code
      );

      // When query is provided: include matching items (even without usage history)
      // When no query: only show items with recent usage
      if (query && !matches) continue;
      if (!query && baseScore === 0) continue;

      // Boost untracked items that match the query so they still appear
      const score = baseScore + boost + (query && baseScore === 0 ? 8 : 0);
      const key = usageKey;

      // Don't overwrite if we already have a task-level suggestion with higher score
      if (!suggestionsMap.has(key) || suggestionsMap.get(key)!.score < score) {
        suggestionsMap.set(key, {
          client: { id: client.id, name: client.name, color: client.color },
          project: { id: project.id, name: project.name, code: project.code },
          task: null,
          score,
          reason: baseScore === 0 ? "match" : reason,
          key,
        });
      }
    }

    // Add client-level suggestions (client only, no project or task)
    for (const client of orgClients) {
      const usageKey = `${client.id}||`;
      const { score: baseScore, reason } = calculateScoreAndReason(usageKey);
      const { matches, boost } = getMatchBoost(query, client.name);

      // When query is provided: include matching items (even without usage history)
      // When no query: only show items with recent usage
      if (query && !matches) continue;
      if (!query && baseScore === 0) continue;

      // Boost untracked items that match the query so they still appear
      const score = baseScore + boost + (query && baseScore === 0 ? 5 : 0);
      const key = usageKey;

      // Don't overwrite if we already have a higher-level suggestion with higher score
      if (!suggestionsMap.has(key) || suggestionsMap.get(key)!.score < score) {
        suggestionsMap.set(key, {
          client: { id: client.id, name: client.name, color: client.color },
          project: null,
          task: null,
          score,
          reason: baseScore === 0 ? "match" : reason,
          key,
        });
      }
    }

    // Sort by score descending and limit results
    const sortedSuggestions = Array.from(suggestionsMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ key, ...rest }) => rest); // Remove the internal key from response

    return NextResponse.json({ suggestions: sortedSuggestions });
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
