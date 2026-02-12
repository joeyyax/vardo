import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { activities, clientContacts, clients, users } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, asc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string; contactId: string }>;
};

// GET /api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]/activities
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, contactId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify contact belongs to client in this org
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
    });
    if (!client) {
      return NextResponse.json(
        { error: "Client not found" },
        { status: 404 }
      );
    }

    const contact = await db.query.clientContacts.findFirst({
      where: and(
        eq(clientContacts.id, contactId),
        eq(clientContacts.clientId, clientId)
      ),
    });
    if (!contact) {
      return NextResponse.json(
        { error: "Contact not found" },
        { status: 404 }
      );
    }

    const results = await db
      .select({
        id: activities.id,
        actorId: activities.actorId,
        actorType: activities.actorType,
        action: activities.action,
        field: activities.field,
        oldValue: activities.oldValue,
        newValue: activities.newValue,
        metadata: activities.metadata,
        createdAt: activities.createdAt,
        actorName: users.name,
        actorEmail: users.email,
      })
      .from(activities)
      .leftJoin(users, eq(activities.actorId, users.id))
      .where(
        and(
          eq(activities.entityType, "contact"),
          eq(activities.entityId, contactId)
        )
      )
      .orderBy(asc(activities.createdAt));

    return NextResponse.json(results);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      error instanceof Error &&
      error.message === "No organization found"
    ) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching contact activities:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
