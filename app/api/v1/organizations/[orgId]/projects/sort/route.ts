import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// PUT /api/v1/organizations/[orgId]/projects/sort
// Body: { order: string[] } — array of project IDs in desired order
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const { order } = await request.json() as { order: string[] };

    await db.transaction(async (tx) => {
      for (let i = 0; i < order.length; i++) {
        await tx
          .update(projects)
          .set({ sortOrder: i })
          .where(and(eq(projects.id, order[i]), eq(projects.organizationId, orgId)));
      }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
