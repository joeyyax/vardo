import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { inboxItems, inboxItemFiles } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getViewUrl, isR2Configured } from "@/lib/r2";

type RouteParams = {
  params: Promise<{ orgId: string; itemId: string; fileId: string }>;
};

// GET /api/v1/organizations/[orgId]/inbox/[itemId]/files/[fileId]
// Returns a signed view URL for an inbox file
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, itemId, fileId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isR2Configured()) {
      return NextResponse.json(
        { error: "File storage not configured" },
        { status: 503 }
      );
    }

    // Verify the inbox item belongs to this org
    const item = await db.query.inboxItems.findFirst({
      where: and(
        eq(inboxItems.id, itemId),
        eq(inboxItems.organizationId, orgId)
      ),
      columns: { id: true },
    });

    if (!item) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Get the file
    const file = await db.query.inboxItemFiles.findFirst({
      where: and(
        eq(inboxItemFiles.id, fileId),
        eq(inboxItemFiles.inboxItemId, itemId)
      ),
    });

    if (!file) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const url = await getViewUrl(file.r2Key);

    return NextResponse.json({ url, file });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error getting inbox file URL:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
