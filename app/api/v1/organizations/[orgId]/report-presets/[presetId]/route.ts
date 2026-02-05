import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { savedReportPresets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; presetId: string }>;
};

// DELETE /api/v1/organizations/[orgId]/report-presets/[presetId] - Delete a preset (only if owned by current user)
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, presetId } = await params;
    const { session, organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await db.delete(savedReportPresets).where(
      and(
        eq(savedReportPresets.id, presetId),
        eq(savedReportPresets.organizationId, orgId),
        eq(savedReportPresets.userId, session.user.id)
      )
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error deleting report preset:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
