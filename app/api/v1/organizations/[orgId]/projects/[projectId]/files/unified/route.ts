import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projectFiles, projects, documents } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";
import type { UnifiedFile } from "@/lib/types/project-files";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: { client: true },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }
  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/files/unified
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

    // Parse optional filters
    const { searchParams } = new URL(request.url);
    const kindFilter = searchParams.get("kind"); // "uploaded" | "generated"
    const tagFilter = searchParams.get("tag");
    const searchQuery = searchParams.get("search")?.toLowerCase();

    // Fetch both in parallel
    const [fileRows, docRows] = await Promise.all([
      kindFilter === "generated"
        ? Promise.resolve([])
        : db.query.projectFiles.findMany({
            where: eq(projectFiles.projectId, projectId),
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
              eq(documents.projectId, projectId),
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

    // Build a map of replacesId -> replacedById for superseding chains
    const replacedByMap = new Map<string, string>();
    for (const f of fileRows) {
      if (f.replacesId) {
        replacedByMap.set(f.replacesId, f.id);
      }
    }

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
      replacesId: f.replacesId ? `file_${f.replacesId}` : null,
      replacedById: replacedByMap.has(f.id)
        ? `file_${replacedByMap.get(f.id)}`
        : null,
      sourceTable: "project_files",
      sourceId: f.id,
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
    }));

    let allFiles: UnifiedFile[] = [...uploadedFiles, ...generatedFiles];

    // Apply tag filter (only affects uploaded files, docs have no tags)
    if (tagFilter) {
      allFiles = allFiles.filter(
        (f) => f.kind === "generated" || f.tags.includes(tagFilter)
      );
    }

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

    // Build superseding chains: nest superseded files under their replacement
    const supersededIds = new Set<string>();
    for (const f of allFiles) {
      if (f.replacesId) {
        supersededIds.add(f.replacesId);
      }
    }

    // Collect previous versions for each current file
    const fileMap = new Map<string, UnifiedFile>();
    for (const f of allFiles) {
      fileMap.set(f.id, f);
    }

    // Walk replacement chains: for each file that replaces another, collect the full chain
    for (const f of allFiles) {
      if (f.replacesId && fileMap.has(f.replacesId)) {
        const versions: UnifiedFile[] = [];
        let currentId: string | null | undefined = f.replacesId;
        while (currentId && fileMap.has(currentId)) {
          const prev: UnifiedFile = fileMap.get(currentId)!;
          versions.push(prev);
          currentId = prev.replacesId;
        }
        f.previousVersions = versions;
      }
    }

    // Remove superseded files from top-level list
    const topLevelFiles = allFiles.filter((f) => !supersededIds.has(f.id));

    // Collect all unique tags from uploaded files
    const allTags = [
      ...new Set(uploadedFiles.flatMap((f) => f.tags)),
    ].sort();

    return NextResponse.json({
      files: topLevelFiles,
      tags: allTags,
      counts: {
        total: topLevelFiles.length,
        uploaded: topLevelFiles.filter((f) => f.kind === "uploaded").length,
        generated: topLevelFiles.filter((f) => f.kind === "generated").length,
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
    console.error("Error fetching unified files:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
