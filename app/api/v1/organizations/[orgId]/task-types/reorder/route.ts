import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTypes } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// PATCH /api/v1/organizations/[orgId]/task-types/reorder
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { order } = body;

    if (!Array.isArray(order) || order.length === 0) {
      return NextResponse.json(
        { error: "order must be a non-empty array" },
        { status: 400 }
      );
    }

    await db.transaction(async (tx) => {
      for (const item of order) {
        await tx
          .update(taskTypes)
          .set({ position: item.position })
          .where(
            and(eq(taskTypes.id, item.id), eq(taskTypes.organizationId, orgId))
          );
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error reordering task types:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
