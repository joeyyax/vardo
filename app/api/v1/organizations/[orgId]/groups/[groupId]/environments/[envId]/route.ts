import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { groups, groupEnvironments } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { destroyGroupEnvironment } from "@/lib/docker/clone";

type RouteParams = {
  params: Promise<{ orgId: string; groupId: string; envId: string }>;
};

// GET /api/v1/organizations/[orgId]/groups/[groupId]/environments/[envId]
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, groupId, envId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const group = await db.query.groups.findFirst({
      where: and(eq(groups.id, groupId), eq(groups.organizationId, orgId)),
      columns: { id: true },
    });

    if (!group) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const env = await db.query.groupEnvironments.findFirst({
      where: and(
        eq(groupEnvironments.id, envId),
        eq(groupEnvironments.groupId, groupId)
      ),
      with: {
        environments: {
          with: {
            project: {
              columns: { id: true, name: true, displayName: true },
            },
          },
        },
      },
    });

    if (!env) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ environment: env });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// DELETE /api/v1/organizations/[orgId]/groups/[groupId]/environments/[envId]
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, groupId, envId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Verify group belongs to org
    const group = await db.query.groups.findFirst({
      where: and(eq(groups.id, groupId), eq(groups.organizationId, orgId)),
      columns: { id: true },
    });

    if (!group) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const result = await destroyGroupEnvironment(envId, orgId);

    return NextResponse.json({
      success: true,
      removed: result.removed,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Group environment not found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    console.error("Error deleting group environment:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
