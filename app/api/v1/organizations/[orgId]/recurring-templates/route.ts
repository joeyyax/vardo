import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { recurringTemplates, clients, projects, tasks, timeEntries } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import {
  getDay,
  getDate,
  getMonth,
  parseISO,
  isBefore,
  startOfDay,
  differenceInWeeks,
} from "date-fns";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// Helper to check if a template should show for a given date
function shouldShowForDate(
  template: {
    frequency: string;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    startDate: string;
    isPaused: boolean | null;
    skippedDates: string[] | null;
  },
  dateStr: string
): boolean {
  if (template.isPaused) return false;

  const date = parseISO(dateStr);
  const startDate = parseISO(template.startDate);

  // Don't show before start date
  if (isBefore(date, startOfDay(startDate))) return false;

  // Check if this date was skipped
  if (template.skippedDates?.includes(dateStr)) return false;

  const dayOfWeek = getDay(date); // 0-6 (Sunday-Saturday)
  const dayOfMonth = getDate(date); // 1-31
  const month = getMonth(date); // 0-11

  switch (template.frequency) {
    case "daily":
      return true;

    case "weekly":
      return template.dayOfWeek === dayOfWeek;

    case "biweekly": {
      if (template.dayOfWeek !== dayOfWeek) return false;
      // Check if it's an even number of weeks since start date
      const weeksDiff = differenceInWeeks(date, startDate);
      return weeksDiff % 2 === 0;
    }

    case "monthly":
      return template.dayOfMonth === dayOfMonth;

    case "quarterly":
      // Show on the specified day in Jan, Apr, Jul, Oct (months 0, 3, 6, 9)
      return template.dayOfMonth === dayOfMonth && month % 3 === 0;

    default:
      return false;
  }
}

// GET /api/v1/organizations/[orgId]/recurring-templates
// Optional query: ?date=YYYY-MM-DD to get suggestions for that date
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { searchParams } = new URL(request.url);
    const dateFilter = searchParams.get("date");

    // Get all templates for this user
    const templates = await db.query.recurringTemplates.findMany({
      where: and(
        eq(recurringTemplates.organizationId, orgId),
        eq(recurringTemplates.userId, session.user.id)
      ),
      with: {
        client: true,
        project: true,
        task: true,
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    // If date filter provided, return suggestions for that date
    if (dateFilter) {
      // Check which templates already have entries for this date
      const existingEntries = await db
        .select({
          clientId: timeEntries.clientId,
          projectId: timeEntries.projectId,
          taskId: timeEntries.taskId,
          description: timeEntries.description,
          durationMinutes: timeEntries.durationMinutes,
        })
        .from(timeEntries)
        .where(
          and(
            eq(timeEntries.organizationId, orgId),
            eq(timeEntries.userId, session.user.id),
            eq(timeEntries.date, dateFilter)
          )
        );

      const suggestions = templates
        .filter((t) =>
          shouldShowForDate(
            {
              frequency: t.frequency,
              dayOfWeek: t.dayOfWeek,
              dayOfMonth: t.dayOfMonth,
              startDate: t.startDate,
              isPaused: t.isPaused,
              skippedDates: t.skippedDates,
            },
            dateFilter
          )
        )
        .filter((t) => {
          // Don't suggest if an entry with same details already exists
          return !existingEntries.some(
            (e) =>
              e.clientId === t.clientId &&
              e.projectId === t.projectId &&
              e.taskId === t.taskId &&
              e.description === t.description &&
              e.durationMinutes === t.durationMinutes
          );
        });

      return NextResponse.json({ suggestions });
    }

    return NextResponse.json({ templates });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching recurring templates:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/recurring-templates
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const {
      clientId,
      projectId,
      taskId,
      description,
      durationMinutes,
      isBillableOverride,
      frequency,
      dayOfWeek,
      dayOfMonth,
      startDate,
    } = body;

    // Validate required fields
    if (!clientId || !durationMinutes || !frequency || !startDate) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Validate frequency
    const validFrequencies = ["daily", "weekly", "biweekly", "monthly", "quarterly"];
    if (!validFrequencies.includes(frequency)) {
      return NextResponse.json(
        { error: "Invalid frequency" },
        { status: 400 }
      );
    }

    // Validate dayOfWeek for weekly/biweekly
    if (["weekly", "biweekly"].includes(frequency) && (dayOfWeek === undefined || dayOfWeek === null)) {
      return NextResponse.json(
        { error: "dayOfWeek required for weekly/biweekly frequency" },
        { status: 400 }
      );
    }

    // Validate dayOfMonth for monthly/quarterly
    if (["monthly", "quarterly"].includes(frequency) && (dayOfMonth === undefined || dayOfMonth === null)) {
      return NextResponse.json(
        { error: "dayOfMonth required for monthly/quarterly frequency" },
        { status: 400 }
      );
    }

    // Verify client belongs to org
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    // Verify project if provided
    if (projectId) {
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), eq(projects.clientId, clientId)),
      });
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
    }

    // Verify task if provided
    if (taskId && projectId) {
      const task = await db.query.tasks.findFirst({
        where: and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)),
      });
      if (!task) {
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
      }
    }

    const [template] = await db
      .insert(recurringTemplates)
      .values({
        organizationId: orgId,
        userId: session.user.id,
        clientId,
        projectId: projectId || null,
        taskId: taskId || null,
        description: description || null,
        durationMinutes,
        isBillableOverride: isBillableOverride ?? null,
        frequency,
        dayOfWeek: dayOfWeek ?? null,
        dayOfMonth: dayOfMonth ?? null,
        startDate,
      })
      .returning();

    // Fetch with relations
    const created = await db.query.recurringTemplates.findFirst({
      where: eq(recurringTemplates.id, template.id),
      with: {
        client: true,
        project: true,
        task: true,
      },
    });

    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating recurring template:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
