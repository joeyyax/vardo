import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, INBOX_ITEM_STATUSES, type InboxItemStatus, projects, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string }>;
};

// GET /api/v1/organizations/[orgId]/inbox/[itemId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
      with: {
        files: true,
        convertedExpense: {
          columns: {
            id: true,
            description: true,
            amountCents: true,
            date: true,
          },
        },
      },
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ item });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching inbox item:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/inbox/[itemId]
// Update status and/or reassign scope (down-only)
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { status, clientId, projectId } = body;

    // Verify item exists and belongs to this org
    const existing = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    // Status update
    if (status) {
      if (!INBOX_ITEM_STATUSES.includes(status as InboxItemStatus)) {
        return NextResponse.json(
          { error: "Invalid status. Must be one of: " + INBOX_ITEM_STATUSES.join(", ") },
          { status: 400 }
        );
      }
      updates.status = status;
    }

    // Scope reassignment (down-only)
    if (projectId) {
      // Verify project exists and belongs to this org
      const project = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
        with: { client: { columns: { id: true, organizationId: true } } },
      });

      if (!project || project.client.organizationId !== orgId) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }

      // Down-only: can't reassign if already has a project
      if (existing.projectId && existing.projectId !== projectId) {
        return NextResponse.json(
          { error: "Item already scoped to a project. Cannot reassign laterally." },
          { status: 400 }
        );
      }

      updates.projectId = projectId;
      updates.clientId = project.clientId; // Auto-set from project's parent
    } else if (clientId) {
      // Down-only: can't set client if already has a project
      if (existing.projectId) {
        return NextResponse.json(
          { error: "Item already scoped to a project. Cannot widen scope." },
          { status: 400 }
        );
      }
      // Can't reassign if already has a different client
      if (existing.clientId && existing.clientId !== clientId) {
        return NextResponse.json(
          { error: "Item already scoped to a client. Cannot reassign laterally." },
          { status: 400 }
        );
      }
      // Verify client exists and belongs to this org
      const client = await db.query.clients.findFirst({
        where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
      });
      if (!client) {
        return NextResponse.json({ error: "Client not found" }, { status: 404 });
      }

      updates.clientId = clientId;
    }

    // Must have at least one update
    if (Object.keys(updates).length === 1) {
      // Only updatedAt — nothing meaningful to change
      return NextResponse.json(
        { error: "No valid fields to update" },
        { status: 400 }
      );
    }

    const [updated] = await db
      .update(inboxItems)
      .set(updates)
      .where(eq(inboxItems.id, itemId))
      .returning();

    return NextResponse.json({ item: updated });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating inbox item:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
