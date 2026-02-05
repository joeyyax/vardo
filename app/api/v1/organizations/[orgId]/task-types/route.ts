import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTypes } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, asc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/task-types
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const types = await db.query.taskTypes.findMany({
      where: eq(taskTypes.organizationId, orgId),
      orderBy: [asc(taskTypes.position), asc(taskTypes.name)],
    });

    return NextResponse.json(types);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching task types:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/task-types
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name, color, icon, defaultFields, position } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const [newType] = await db
      .insert(taskTypes)
      .values({
        organizationId: orgId,
        name: name.trim(),
        color: color || null,
        icon: icon || null,
        defaultFields: defaultFields || null,
        position: position ?? 0,
      })
      .returning();

    return NextResponse.json(newType, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating task type:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
