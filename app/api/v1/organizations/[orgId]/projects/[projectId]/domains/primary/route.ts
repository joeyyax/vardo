import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, domains } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

// PUT — set primary domain
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const { organization } = await requireOrg();
    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { domainId } = await request.json();

    // Clear all primary flags for this project
    await db
      .update(domains)
      .set({ isPrimary: false })
      .where(eq(domains.projectId, projectId));

    // Set the selected domain as primary
    await db
      .update(domains)
      .set({ isPrimary: true })
      .where(and(eq(domains.id, domainId), eq(domains.projectId, projectId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
