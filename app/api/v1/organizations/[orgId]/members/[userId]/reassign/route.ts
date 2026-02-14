import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clients, projects, tasks, memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and, inArray } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; userId: string }>;
};

const VALID_ENTITY_TYPES = ["clients", "projects", "tasks"] as const;
type EntityType = (typeof VALID_ENTITY_TYPES)[number];

// POST /api/v1/organizations/[orgId]/members/[userId]/reassign
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, userId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { newAssignee, entityTypes } = body;

    // Validate newAssignee (string or null for unassign)
    if (newAssignee !== null && typeof newAssignee !== "string") {
      return NextResponse.json(
        { error: "newAssignee must be a string or null" },
        { status: 400 }
      );
    }

    // Validate entityTypes
    if (!Array.isArray(entityTypes) || entityTypes.length === 0) {
      return NextResponse.json(
        { error: "entityTypes must be a non-empty array" },
        { status: 400 }
      );
    }

    for (const t of entityTypes) {
      if (!VALID_ENTITY_TYPES.includes(t)) {
        return NextResponse.json(
          { error: `Invalid entity type: ${t}. Must be one of: ${VALID_ENTITY_TYPES.join(", ")}` },
          { status: 400 }
        );
      }
    }

    // If newAssignee is set, verify they are a member of this org
    if (newAssignee) {
      const targetMembership = await db.query.memberships.findFirst({
        where: and(
          eq(memberships.organizationId, orgId),
          eq(memberships.userId, newAssignee)
        ),
      });
      if (!targetMembership) {
        return NextResponse.json(
          { error: "New assignee is not a member of this organization" },
          { status: 400 }
        );
      }
    }

    const counts: Record<string, number> = {};
    const types = entityTypes as EntityType[];

    // Reassign clients (directly org-scoped)
    if (types.includes("clients")) {
      const result = await db
        .update(clients)
        .set({ assignedTo: newAssignee, updatedAt: new Date() })
        .where(
          and(
            eq(clients.assignedTo, userId),
            eq(clients.organizationId, orgId)
          )
        )
        .returning({ id: clients.id });
      counts.clients = result.length;
    }

    // Fetch org client IDs once (needed for projects and tasks)
    const needsClientIds = types.includes("projects") || types.includes("tasks");
    const clientIds = needsClientIds
      ? (await db.select({ id: clients.id }).from(clients).where(eq(clients.organizationId, orgId))).map((c) => c.id)
      : [];

    // Reassign projects (scoped through clients)
    if (types.includes("projects")) {
      if (clientIds.length > 0) {
        const result = await db
          .update(projects)
          .set({ assignedTo: newAssignee, updatedAt: new Date() })
          .where(
            and(
              eq(projects.assignedTo, userId),
              inArray(projects.clientId, clientIds)
            )
          )
          .returning({ id: projects.id });
        counts.projects = result.length;
      } else {
        counts.projects = 0;
      }
    }

    // Reassign tasks (scoped through projects -> clients)
    if (types.includes("tasks")) {
      if (clientIds.length > 0) {
        const projectIds = (
          await db.select({ id: projects.id }).from(projects).where(inArray(projects.clientId, clientIds))
        ).map((p) => p.id);

        if (projectIds.length > 0) {
          const result = await db
            .update(tasks)
            .set({ assignedTo: newAssignee, updatedAt: new Date() })
            .where(
              and(
                eq(tasks.assignedTo, userId),
                inArray(tasks.projectId, projectIds)
              )
            )
            .returning({ id: tasks.id });
          counts.tasks = result.length;
        } else {
          counts.tasks = 0;
        }
      } else {
        counts.tasks = 0;
      }
    }

    return NextResponse.json({ success: true, counts });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    console.error("Error bulk reassigning:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
