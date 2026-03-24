import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { appTags } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const tagActionSchema = z.object({
  tagId: z.string().min(1, "Tag ID is required"),
});

// POST /api/v1/organizations/[orgId]/apps/[appId]/tags
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
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

    await db.insert(appTags).values({
      appId,
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
        { error: "Tag already applied to this app" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error adding tag to app");
  }
}

// DELETE /api/v1/organizations/[orgId]/apps/[appId]/tags
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
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
      .delete(appTags)
      .where(
        and(
          eq(appTags.appId, appId),
          eq(appTags.tagId, parsed.data.tagId)
        )
      )
      .returning({ appId: appTags.appId });

    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error removing tag from app");
  }
}
