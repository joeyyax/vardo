import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projectTags } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { verifyProjectAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; projectId: string }>;
};

const tagActionSchema = z.object({
  tagId: z.string().min(1, "Tag ID is required"),
});

// POST /api/v1/organizations/[orgId]/projects/[projectId]/tags
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = tagActionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    await db.insert(projectTags).values({
      projectId,
      tagId: parsed.data.tagId,
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "Tag already applied to this project" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error adding tag to project");
  }
}

// DELETE /api/v1/organizations/[orgId]/projects/[projectId]/tags
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, projectId } = await params;
    const project = await verifyProjectAccess(orgId, projectId);

    if (!project) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = tagActionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [deleted] = await db
      .delete(projectTags)
      .where(
        and(
          eq(projectTags.projectId, projectId),
          eq(projectTags.tagId, parsed.data.tagId)
        )
      )
      .returning({ projectId: projectTags.projectId });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error removing tag from project");
  }
}
