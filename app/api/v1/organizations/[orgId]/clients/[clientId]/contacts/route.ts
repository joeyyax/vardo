import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientContacts, clients, CONTACT_TYPES } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, asc } from "drizzle-orm";
import { sql } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
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

// GET /api/v1/organizations/[orgId]/clients/[clientId]/contacts
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const contacts = await db
      .select()
      .from(clientContacts)
      .where(eq(clientContacts.clientId, clientId))
      .orderBy(
        sql`CASE ${clientContacts.type} WHEN 'primary' THEN 0 WHEN 'billing' THEN 1 ELSE 2 END`,
        asc(clientContacts.name)
      );

    return NextResponse.json(contacts);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching client contacts:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/clients/[clientId]/contacts
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, email, phone, title, type } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    if (type && !CONTACT_TYPES.includes(type)) {
      return NextResponse.json(
        { error: `Invalid type. Must be one of: ${CONTACT_TYPES.join(", ")}` },
        { status: 400 }
      );
    }

    const [contact] = await db
      .insert(clientContacts)
      .values({
        clientId,
        type: type || "other",
        name: name.trim(),
        email: email?.trim() || null,
        phone: phone?.trim() || null,
        title: title?.trim() || null,
      })
      .returning();

    return NextResponse.json(contact, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating client contact:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
