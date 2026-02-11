import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, dataExportRequests } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

async function verifyProjectAccess(projectId: string, orgId: string) {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      client: { columns: { organizationId: true } },
    },
  });

  if (!project || project.client.organizationId !== orgId) {
    return null;
  }
  return project;
}

// GET — get the latest data export request status
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectAccess(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const latestExport = await db.query.dataExportRequests.findFirst({
      where: and(
        eq(dataExportRequests.projectId, projectId),
        eq(dataExportRequests.organizationId, orgId)
      ),
      orderBy: [desc(dataExportRequests.requestedAt)],
    });

    return NextResponse.json({ export: latestExport ?? null });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching export status:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST — request a new data export
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await verifyProjectAccess(projectId, orgId);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (project.stage !== "offboarding" && project.stage !== "completed") {
      return NextResponse.json(
        { error: "Data exports are only available during offboarding or after completion" },
        { status: 400 }
      );
    }

    // Check for an existing pending/processing export
    const existing = await db.query.dataExportRequests.findFirst({
      where: and(
        eq(dataExportRequests.projectId, projectId),
        eq(dataExportRequests.organizationId, orgId)
      ),
      orderBy: [desc(dataExportRequests.requestedAt)],
    });

    if (existing && (existing.status === "requested" || existing.status === "processing")) {
      return NextResponse.json(
        { error: "An export is already in progress", export: existing },
        { status: 409 }
      );
    }

    const body = await request.json().catch(() => ({}));

    const [exportRequest] = await db
      .insert(dataExportRequests)
      .values({
        projectId,
        organizationId: orgId,
        requestedBy: session.user.id,
        status: "requested",
        includes: {
          code: body.code !== false,
          database: body.database !== false,
          media: body.media !== false,
        },
        notes: body.notes || null,
      })
      .returning();

    return NextResponse.json({ export: exportRequest }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error requesting data export:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
