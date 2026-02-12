import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clients, projects, projectFiles, documents } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, inArray, desc } from "drizzle-orm";
import type { UnifiedFile } from "@/lib/types/project-files";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
};

// GET /api/v1/organizations/[orgId]/clients/[clientId]/files
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify client belongs to org
    const client = await db.query.clients.findFirst({
      where: and(eq(clients.id, clientId), eq(clients.organizationId, orgId)),
    });

    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    // Get all projects for this client
    const clientProjects = await db.query.projects.findMany({
      where: eq(projects.clientId, clientId),
      columns: { id: true, name: true },
    });

    if (clientProjects.length === 0) {
      return NextResponse.json({
        files: [],
        counts: { total: 0, uploaded: 0, generated: 0 },
      });
    }

    const projectIds = clientProjects.map((p) => p.id);
    const projectNameMap = new Map(clientProjects.map((p) => [p.id, p.name]));

    // Parse optional filters
    const { searchParams } = new URL(request.url);
    const kindFilter = searchParams.get("kind");
    const searchQuery = searchParams.get("search")?.toLowerCase();

    // Fetch files and documents in parallel across all projects
    const [fileRows, docRows] = await Promise.all([
      kindFilter === "generated"
        ? Promise.resolve([])
        : db.query.projectFiles.findMany({
            where: inArray(projectFiles.projectId, projectIds),
            orderBy: [desc(projectFiles.createdAt)],
            with: {
              uploadedByUser: {
                columns: { id: true, name: true, email: true },
              },
            },
          }),
      kindFilter === "uploaded"
        ? Promise.resolve([])
        : db.query.documents.findMany({
            where: and(
              inArray(documents.projectId, projectIds),
              eq(documents.organizationId, orgId)
            ),
            orderBy: [desc(documents.createdAt)],
            with: {
              createdByUser: {
                columns: { id: true, name: true, email: true },
              },
            },
          }),
    ]);

    // Normalize uploaded files
    const uploadedFiles: UnifiedFile[] = fileRows.map((f) => ({
      id: `file_${f.id}`,
      kind: "uploaded",
      name: f.name,
      createdAt: f.createdAt.toISOString(),
      createdBy: f.uploadedByUser || null,
      tags: (f.tags as string[]) || [],
      isPublic: f.isPublic ?? false,
      sizeBytes: f.sizeBytes,
      mimeType: f.mimeType,
      sourceTable: "project_files",
      sourceId: f.id,
      projectId: f.projectId,
      projectName: projectNameMap.get(f.projectId) || "",
    }));

    // Normalize generated documents
    const generatedFiles: UnifiedFile[] = docRows.map((d) => ({
      id: `doc_${d.id}`,
      kind: "generated",
      name: d.title,
      createdAt: d.createdAt.toISOString(),
      createdBy: d.createdByUser || null,
      tags: [],
      isPublic: d.publicToken !== null && d.status !== "draft",
      documentType: d.type as UnifiedFile["documentType"],
      documentStatus: d.status as UnifiedFile["documentStatus"],
      publicToken: d.publicToken,
      sentAt: d.sentAt?.toISOString() ?? null,
      sourceTable: "documents",
      sourceId: d.id,
      projectId: d.projectId,
      projectName: projectNameMap.get(d.projectId) || "",
    }));

    let allFiles: UnifiedFile[] = [...uploadedFiles, ...generatedFiles];

    // Apply search filter
    if (searchQuery) {
      allFiles = allFiles.filter((f) =>
        f.name.toLowerCase().includes(searchQuery)
      );
    }

    // Sort by createdAt descending
    allFiles.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return NextResponse.json({
      files: allFiles,
      counts: {
        total: allFiles.length,
        uploaded: allFiles.filter((f) => f.kind === "uploaded").length,
        generated: allFiles.filter((f) => f.kind === "generated").length,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 }
      );
    }
    console.error("Error fetching client files:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
