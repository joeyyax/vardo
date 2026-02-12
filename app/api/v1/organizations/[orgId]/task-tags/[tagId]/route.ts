import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTags } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; tagId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/task-tags/[tagId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, tagId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTags.findFirst({
      where: and(
        eq(taskTags.id, tagId),
        eq(taskTags.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, color, isPredefined } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (color !== undefined) updates.color = color || null;
    if (isPredefined !== undefined) updates.isPredefined = isPredefined;

    const [updated] = await db
      .update(taskTags)
      .set(updates)
      .where(eq(taskTags.id, tagId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating task tag:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/task-tags/[tagId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, tagId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTags.findFirst({
      where: and(
        eq(taskTags.id, tagId),
        eq(taskTags.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Tag not found" }, { status: 404 });
    }

    await db.delete(taskTags).where(eq(taskTags.id, tagId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting task tag:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
