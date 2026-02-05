import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { savedReportPresets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and, desc } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/report-presets - List presets for current user
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const presets = await db.query.savedReportPresets.findMany({
      where: and(
        eq(savedReportPresets.organizationId, orgId),
        eq(savedReportPresets.userId, session.user.id)
      ),
      orderBy: [desc(savedReportPresets.createdAt)],
    });

    return NextResponse.json(presets);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching report presets:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/report-presets - Create a preset
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const { name, tab, filters } = body;

    if (!name || !tab || !filters) {
      return NextResponse.json(
        { error: "name, tab, and filters are required" },
        { status: 400 }
      );
    }

    const [preset] = await db
      .insert(savedReportPresets)
      .values({
        organizationId: orgId,
        userId: session.user.id,
        name,
        tab,
        filters,
      })
      .returning();

    return NextResponse.json(preset, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating report preset:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
