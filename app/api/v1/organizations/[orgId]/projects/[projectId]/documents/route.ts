import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents, projects, DOCUMENT_TYPES, type DocumentType, type DocumentContent } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

/**
 * Verify that the project belongs to the organization.
 */
async function verifyProjectBelongsToOrg(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: true,
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }

  return project;
}

// GET /api/v1/organizations/[orgId]/projects/[projectId]/documents
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

    // Get optional type filter
    const { searchParams } = new URL(request.url);
    const typeFilter = searchParams.get("type") as DocumentType | null;

    const whereConditions = [
      eq(documents.projectId, projectId),
      eq(documents.organizationId, orgId),
    ];

    if (typeFilter && DOCUMENT_TYPES.includes(typeFilter)) {
      whereConditions.push(eq(documents.type, typeFilter));
    }

    const docs = await db.query.documents.findMany({
      where: and(...whereConditions),
      orderBy: [desc(documents.createdAt)],
      with: {
        createdByUser: {
          columns: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return NextResponse.json(docs);
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

// POST /api/v1/organizations/[orgId]/projects/[projectId]/documents
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectBelongsToOrg(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { type, title, content, requiresContract } = body;

    // Validate type
    if (!type || !DOCUMENT_TYPES.includes(type)) {
      return NextResponse.json(
        { error: "Invalid document type. Must be 'proposal' or 'contract'" },
        { status: 400 }
      );
    }

    // Validate title
    if (!title || typeof title !== "string" || !title.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }

    // Default content structure
    const defaultContent: DocumentContent = {
      sections: [
        {
          id: nanoid(8),
          type: "intro",
          title: "Introduction",
          content: "",
          order: 0,
        },
        {
          id: nanoid(8),
          type: "scope",
          title: "Scope of Work",
          content: "",
          order: 1,
        },
        {
          id: nanoid(8),
          type: "deliverables",
          title: "Deliverables",
          content: "",
          order: 2,
        },
        {
          id: nanoid(8),
          type: "timeline",
          title: "Timeline",
          content: "",
          order: 3,
        },
        {
          id: nanoid(8),
          type: "pricing",
          title: "Pricing",
          content: "",
          order: 4,
        },
        {
          id: nanoid(8),
          type: "terms",
          title: "Terms & Conditions",
          content: "",
          order: 5,
        },
      ],
    };

    // Use provided content or default
    const documentContent: DocumentContent = content && typeof content === "object"
      ? content
      : defaultContent;

    // Generate public token
    const publicToken = nanoid(32);

    const [document] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        projectId,
        type,
        title: title.trim(),
        content: documentContent,
        requiresContract: type === "proposal" ? (requiresContract === true) : false,
        publicToken,
        createdBy: session.user.id,
      })
      .returning();

    return NextResponse.json(document, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating document:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
