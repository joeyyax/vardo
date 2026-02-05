import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents, projects, clients, DOCUMENT_TYPES, DOCUMENT_STATUSES, type DocumentType, type DocumentStatus } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc, inArray } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/documents
// List all documents across all projects in the organization
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get optional filters
    const { searchParams } = new URL(request.url);
    const typeFilter = searchParams.get("type") as DocumentType | null;
    const statusFilter = searchParams.get("status") as DocumentStatus | null;
    const clientId = searchParams.get("clientId");
    const projectId = searchParams.get("projectId");

    // Build where conditions
    const whereConditions = [eq(documents.organizationId, orgId)];

    if (typeFilter && DOCUMENT_TYPES.includes(typeFilter)) {
      whereConditions.push(eq(documents.type, typeFilter));
    }
    if (statusFilter && DOCUMENT_STATUSES.includes(statusFilter)) {
      whereConditions.push(eq(documents.status, statusFilter));
    }
    if (projectId) {
      whereConditions.push(eq(documents.projectId, projectId));
    }

    // If filtering by client, we need to get project IDs first
    let projectIds: string[] | null = null;
    if (clientId) {
      const clientProjects = await db.query.projects.findMany({
        where: eq(projects.clientId, clientId),
        columns: { id: true },
      });
      projectIds = clientProjects.map((p) => p.id);
      if (projectIds.length === 0) {
        // No projects for this client, return empty
        return NextResponse.json({
          documents: [],
          summary: {
            total: 0,
            byStatus: {},
            byType: {},
          },
        });
      }
      whereConditions.push(inArray(documents.projectId, projectIds));
    }

    const docs = await db.query.documents.findMany({
      where: and(...whereConditions),
      orderBy: [desc(documents.createdAt)],
      with: {
        project: {
          columns: {
            id: true,
            name: true,
          },
          with: {
            client: {
              columns: {
                id: true,
                name: true,
                color: true,
              },
            },
          },
        },
        createdByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Calculate summary stats
    const allDocs = await db.query.documents.findMany({
      where: eq(documents.organizationId, orgId),
      columns: {
        type: true,
        status: true,
      },
    });

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const doc of allDocs) {
      byStatus[doc.status] = (byStatus[doc.status] || 0) + 1;
      byType[doc.type] = (byType[doc.type] || 0) + 1;
    }

    return NextResponse.json({
      documents: docs,
      summary: {
        total: allDocs.length,
        byStatus,
        byType,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching documents:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
