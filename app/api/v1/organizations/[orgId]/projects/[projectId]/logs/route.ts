import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { listContainers, getContainerLogs } from "@/lib/docker/client";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// GET /api/v1/organizations/[orgId]/projects/[projectId]/logs
export async function GET(request: NextRequest, { params }: RouteParams) {
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

    const searchParams = request.nextUrl.searchParams;
    const tail = parseInt(searchParams.get("tail") || "200");

    // Find containers for this project
    const containers = await listContainers(project.name);

    if (containers.length === 0) {
      return NextResponse.json({
        logs: "No running containers found for this project.",
        containers: [],
      });
    }

    // Fetch logs from all containers
    const allLogs: string[] = [];
    for (const container of containers) {
      try {
        const log = await getContainerLogs(container.id, { tail });
        allLogs.push(`── ${container.name} ──`);
        allLogs.push(log || "(no output)");
        allLogs.push("");
      } catch (err) {
        allLogs.push(`── ${container.name} ──`);
        allLogs.push(`Error fetching logs: ${err instanceof Error ? err.message : err}`);
        allLogs.push("");
      }
    }

    return NextResponse.json({
      logs: allLogs.join("\n"),
      containers: containers.map((c) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        image: c.image,
      })),
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching logs:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
