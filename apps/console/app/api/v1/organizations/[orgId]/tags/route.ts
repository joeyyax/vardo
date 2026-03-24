import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { tags } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, asc } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { randomPaletteColor } from "@/lib/ui/colors";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createTagSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid hex color").optional(),
});

// GET /api/v1/organizations/[orgId]/tags
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const tagList = await db.query.tags.findMany({
      where: eq(tags.organizationId, orgId),
      orderBy: [asc(tags.name)],
    });

    return NextResponse.json({ tags: tagList });
  } catch (error) {
    return handleRouteError(error, "Error fetching tags");
  }
}

// POST /api/v1/organizations/[orgId]/tags
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createTagSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const [tag] = await db
      .insert(tags)
      .values({
        id: nanoid(),
        organizationId: orgId,
        name: parsed.data.name,
        color: parsed.data.color || randomPaletteColor(),
      })
      .returning();

    return NextResponse.json({ tag }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "A tag with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating tag");
  }
}
