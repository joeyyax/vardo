import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientContacts, clients, CONTACT_TYPES } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string; contactId: string }>;
};

async function verifyClientBelongsToOrg(clientId: string, orgId: string) {
  const client = await db.query.clients.findFirst({
    where: and(
      eq(clients.id, clientId),
      eq(clients.organizationId, orgId)
    ),
  });
  return client;
}

// PATCH /api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, contactId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const existing = await db.query.clientContacts.findFirst({
      where: and(
        eq(clientContacts.id, contactId),
        eq(clientContacts.clientId, clientId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, email, phone, title, type } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }

    if (type !== undefined && !CONTACT_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `Invalid type. Must be one of: ${CONTACT_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (name !== undefined) updates.name = name.trim();
    if (email !== undefined) updates.email = email?.trim() || null;
    if (phone !== undefined) updates.phone = phone?.trim() || null;
    if (title !== undefined) updates.title = title?.trim() || null;
    if (type !== undefined) updates.type = type;

    const [updated] = await db
      .update(clientContacts)
      .set(updates)
      .where(eq(clientContacts.id, contactId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating client contact:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/clients/[clientId]/contacts/[contactId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, contactId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const existing = await db.query.clientContacts.findFirst({
      where: and(
        eq(clientContacts.id, contactId),
        eq(clientContacts.clientId, clientId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Contact not found" }, { status: 404 });
    }

    await db.delete(clientContacts).where(eq(clientContacts.id, contactId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting client contact:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
