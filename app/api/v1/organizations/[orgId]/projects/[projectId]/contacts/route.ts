import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, clients, clientContacts, projectContacts } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { resolveProjectContacts } from "@/lib/contacts/resolve";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: { columns: { id: true, organizationId: true, name: true } },
    },
  });
  if (!project || project.client.organizationId !== orgId) return null;
  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/contacts
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const result = await resolveProjectContacts(projectId, project.client.id);

    return NextResponse.json({
      contacts: result.contacts,
      source: result.source,
      clientId: project.client.id,
      clientName: project.client.name,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching project contacts:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/projects/[projectId]/contacts
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { contactId } = body;

    if (!contactId) {
      return NextResponse.json({ error: "contactId is required" }, { status: 400 });
    }

    // Verify the contact belongs to this project's client
    const contact = await db.query.clientContacts.findFirst({
      where: and(
        eq(clientContacts.id, contactId),
        eq(clientContacts.clientId, project.client.id)
      ),
    });

    if (!contact) {
      return NextResponse.json(
        { error: "Contact not found or does not belong to this project's client" },
        { status: 404 }
      );
    }

    // Check for duplicate
    const existing = await db.query.projectContacts.findFirst({
      where: and(
        eq(projectContacts.projectId, projectId),
        eq(projectContacts.contactId, contactId)
      ),
    });

    if (existing) {
      return NextResponse.json(
        { error: "Contact already assigned to this project" },
        { status: 409 }
      );
    }

    const [row] = await db
      .insert(projectContacts)
      .values({ projectId, contactId })
      .returning();

    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error adding project contact:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
