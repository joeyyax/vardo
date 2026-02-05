import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectInvitations, tasks, timeEntries } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, and, or, sql, isNull } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ projectId: string }>;
};

// GET /api/portal/projects/[projectId]
// Returns project details for the portal (respecting visibility settings)
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { projectId } = await params;
    const session = await getSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find the invitation for this user and project
    const invitation = await db.query.projectInvitations.findFirst({
      where: and(
        eq(projectInvitations.projectId, projectId),
        or(
          eq(projectInvitations.userId, session.user.id),
          eq(projectInvitations.email, session.user.email?.toLowerCase() ?? "")
        )
      ),
      with: {
        project: {
          with: {
            client: {
              with: {
                organization: {
                  columns: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
            tasks: {
              where: isNull(tasks.isArchived),
              orderBy: (t, { asc }) => [asc(t.position), asc(t.createdAt)],
            },
          },
        },
      },
    });

    if (!invitation) {
      return NextResponse.json({ error: "Project not found or access denied" }, { status: 404 });
    }

    const project = invitation.project;
    const visibility = invitation.visibility ?? {
      show_rates: false,
      show_time: true,
      show_costs: false,
    };

    // Calculate stats
    const projectTasks = project.tasks.filter((t) => t.status !== null);
    const completedTasks = projectTasks.filter((t) => t.status === "done").length;

    let totalHours: number | undefined;
    if (visibility.show_time) {
      // Calculate total hours from time entries
      const [result] = await db
        .select({
          totalMinutes: sql<number>`COALESCE(SUM(${timeEntries.durationMinutes}), 0)`,
        })
        .from(timeEntries)
        .where(eq(timeEntries.projectId, projectId));

      totalHours = (result?.totalMinutes ?? 0) / 60;
    }

    // Transform tasks for response (exclude sensitive data)
    const responseTasks = project.tasks
      .filter((t) => t.status !== null) // Only show PM tasks in portal
      .map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        status: t.status,
        assignedTo: t.assignedTo,
      }));

    return NextResponse.json({
      id: project.id,
      name: project.name,
      clientName: project.client.name,
      organizationName: project.client.organization.name,
      role: invitation.role,
      visibility,
      tasks: responseTasks,
      stats: {
        totalTasks: projectTasks.length,
        completedTasks,
        totalHours: visibility.show_time ? totalHours : undefined,
      },
    });
  } catch (error) {
    console.error("Error fetching portal project:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
