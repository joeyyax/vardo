import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTypes } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; typeId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/task-types/[typeId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, typeId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTypes.findFirst({
      where: and(
        eq(taskTypes.id, typeId),
        eq(taskTypes.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Task type not found" }, { status: 404 });
    }

    const body = await request.json();
    const { name, color, position, isArchived } = body;

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name.trim();
    if (color !== undefined) updates.color = color;
    if (position !== undefined) updates.position = position;
    if (isArchived !== undefined) updates.isArchived = isArchived;

    const [updated] = await db
      .update(taskTypes)
      .set(updates)
      .where(eq(taskTypes.id, typeId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error updating task type:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/task-types/[typeId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, typeId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existing = await db.query.taskTypes.findFirst({
      where: and(
        eq(taskTypes.id, typeId),
        eq(taskTypes.organizationId, orgId)
      ),
    });

    if (!existing) {
      return NextResponse.json({ error: "Task type not found" }, { status: 404 });
    }

    await db.delete(taskTypes).where(eq(taskTypes.id, typeId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting task type:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
