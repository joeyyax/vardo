import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, domains } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// PUT — set primary domain
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true },
    });
    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { domainId } = await request.json();

    // Clear all primary flags for this app
    await db
      .update(domains)
      .set({ isPrimary: false })
      .where(eq(domains.appId, appId));

    // Set the selected domain as primary
    await db
      .update(domains)
      .set({ isPrimary: true })
      .where(and(eq(domains.id, domainId), eq(domains.appId, appId)));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
