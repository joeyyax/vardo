import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { documents, projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { generateDocumentPdf } from "@/lib/documents/pdf";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string; documentId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/documents/[documentId]/pdf
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId, documentId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: { client: true },
    });

    if (!project || project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Fetch document
    const document = await db.query.documents.findFirst({
      where: and(
        eq(documents.id, documentId),
        eq(documents.projectId, projectId),
        eq(documents.organizationId, orgId)
      ),
    });

    if (!document) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    const content = document.content as {
      sections?: Array<{ title: string; content: string; visible: boolean }>;
    } | null;

    if (!content?.sections?.length) {
      return NextResponse.json(
        { error: "Document has no content to render" },
        { status: 400 }
      );
    }

    // Generate PDF
    const pdfBuffer = await generateDocumentPdf({
      title: document.title,
      sections: content.sections,
      organizationName: organization.name,
    });

    const sanitizedTitle = (document.title || "document")
      .replace(/[^a-zA-Z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase();

    return new NextResponse(Buffer.from(pdfBuffer), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${sanitizedTitle}.pdf"`,
        "Content-Length": pdfBuffer.byteLength.toString(),
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
    console.error("Error generating document PDF:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
