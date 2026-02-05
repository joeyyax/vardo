import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { taskTags } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, asc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/task-tags
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const tags = await db.query.taskTags.findMany({
      where: eq(taskTags.organizationId, orgId),
      orderBy: [asc(taskTags.name)],
    });

    return NextResponse.json(tags);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching task tags:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/task-tags
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name, color, isPredefined } = body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const [newTag] = await db
      .insert(taskTags)
      .values({
        organizationId: orgId,
        name: name.trim(),
        color: color || null,
        isPredefined: isPredefined ?? false,
      })
      .returning();

    return NextResponse.json(newTag, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating task tag:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
