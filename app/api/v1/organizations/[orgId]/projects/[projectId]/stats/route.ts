import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { timeEntries, projects, tasks } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, gte, sql } from "drizzle-orm";
import { startOfMonth, format } from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    // Verify orgId matches user's org
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: {
        client: true,
      },
    });

    if (!project || project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const monthStart = format(startOfMonth(new Date()), "yyyy-MM-dd");

    // Get this month's entries
    const monthEntries = await db
      .select({
        totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.projectId, projectId),
          eq(timeEntries.organizationId, orgId),
          gte(timeEntries.date, monthStart)
        )
      );

    // Get all time entries
    const allTimeEntries = await db
      .select({
        totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
      })
      .from(timeEntries)
      .where(
        and(
          eq(timeEntries.projectId, projectId),
          eq(timeEntries.organizationId, orgId)
        )
      );

    // Get hours by task
    const taskBreakdown = await db
      .select({
        id: tasks.id,
        name: tasks.name,
        minutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
      })
      .from(tasks)
      .leftJoin(
        timeEntries,
        and(
          eq(timeEntries.taskId, tasks.id),
          eq(timeEntries.organizationId, orgId)
        )
      )
      .where(eq(tasks.projectId, projectId))
      .groupBy(tasks.id, tasks.name)
      .orderBy(sql`SUM(${timeEntries.durationMinutes}) DESC NULLS LAST`);

    // Calculate billable amount for the month
    const rate =
      project.rateOverride ?? project.client.rateOverride ?? organization.defaultRate ?? 0;
    const totalMinutes = Number(monthEntries[0]?.totalMinutes || 0);
    const totalBillable = Math.round((totalMinutes / 60) * rate);

    return NextResponse.json({
      totalMinutes,
      totalMinutesAllTime: Number(allTimeEntries[0]?.totalMinutes || 0),
      totalBillable,
      budgetMinutes: null, // TODO: implement project budgets
      budgetRemaining: null,
      taskBreakdown: taskBreakdown.map((t) => ({
        id: t.id,
        name: t.name,
        minutes: Number(t.minutes || 0),
      })),
    });
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
    console.error("Error fetching project stats:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
