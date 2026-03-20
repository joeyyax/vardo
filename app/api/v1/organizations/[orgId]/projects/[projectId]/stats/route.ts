import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getProjectContainers, getContainerStats } from "@/lib/docker/client";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/stats
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(
        eq(projects.id, projectId),
        eq(projects.organizationId, orgId)
      ),
      columns: { id: true, name: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const containers = await getProjectContainers(project.name);

    if (containers.length === 0) {
      return NextResponse.json({ containers: [], timestamp: new Date().toISOString() });
    }

    const stats = await Promise.all(
      containers
        .filter((c) => c.state === "running")
        .map((c) => getContainerStats(c.id))
    );

    return NextResponse.json({
      containers: stats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching container stats:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
