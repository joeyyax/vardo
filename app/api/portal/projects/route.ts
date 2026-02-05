import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectInvitations } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, isNotNull } from "drizzle-orm";

// GET /api/portal/projects
// Returns all projects the current user has been invited to
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find all accepted invitations for this user
    const invitations = await db.query.projectInvitations.findMany({
      where: eq(projectInvitations.userId, session.user.id),
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
          },
        },
      },
    });

    // Also check for invitations by email that haven't been linked yet
    const emailInvitations = await db.query.projectInvitations.findMany({
      where: eq(projectInvitations.email, session.user.email?.toLowerCase() ?? ""),
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
          },
        },
      },
    });

    // Combine and dedupe by project ID
    const allInvitations = [...invitations, ...emailInvitations];
    const projectMap = new Map<string, typeof allInvitations[0]>();

    for (const inv of allInvitations) {
      if (!projectMap.has(inv.projectId)) {
        projectMap.set(inv.projectId, inv);

        // If this is an email-matched invitation that's not linked, link it now
        if (!inv.userId && inv.email === session.user.email?.toLowerCase()) {
          await db
            .update(projectInvitations)
            .set({ userId: session.user.id, acceptedAt: inv.acceptedAt ?? new Date() })
            .where(eq(projectInvitations.id, inv.id));
        }
      }
    }

    // Transform to response format
    const projects = Array.from(projectMap.values()).map((inv) => ({
      id: inv.project.id,
      name: inv.project.name,
      clientName: inv.project.client.name,
      organizationName: inv.project.client.organization.name,
      role: inv.role,
      visibility: inv.visibility,
    }));

    return NextResponse.json(projects);
  } catch (error) {
    console.error("Error fetching portal projects:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
