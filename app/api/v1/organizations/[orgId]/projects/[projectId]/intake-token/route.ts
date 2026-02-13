import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { getOrCreateProjectIntakeToken } from "@/lib/intake-email";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// POST /api/v1/organizations/[orgId]/projects/[projectId]/intake-token
// Generate or retrieve the intake email address for a project
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify project belongs to org
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, projectId),
      with: {
        client: { columns: { organizationId: true } },
      },
    });

    if (!project || project.client.organizationId !== orgId) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const result = await getOrCreateProjectIntakeToken(projectId);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error generating project intake token:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
