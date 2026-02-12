import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, projectContacts } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; contactId: string }>;
};

async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: { columns: { id: true, organizationId: true } },
    },
  });
  if (!project || project.client.organizationId !== orgId) return null;
  return project;
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/contacts/[contactId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, contactId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const existing = await db.query.projectContacts.findFirst({
      where: and(
        eq(projectContacts.projectId, projectId),
        eq(projectContacts.contactId, contactId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Contact assignment not found" }, { status: 404 });
    }

    await db
      .delete(projectContacts)
      .where(
        and(
          eq(projectContacts.projectId, projectId),
          eq(projectContacts.contactId, contactId)
        )
      );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error removing project contact:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
