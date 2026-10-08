import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { appTransfers } from "@/lib/db/schema";
import { eq, or } from "drizzle-orm";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/transfers
// List pending transfers for this org (both incoming and outgoing)
async function handleGet(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const transfers = await db.query.appTransfers.findMany({
      where: or(
        eq(appTransfers.sourceOrgId, orgId),
        eq(appTransfers.destinationOrgId, orgId),
      ),
      with: {
        app: {
          columns: { id: true, name: true, displayName: true },
        },
        sourceOrg: {
          columns: { id: true, name: true, slug: true },
        },
        destinationOrg: {
          columns: { id: true, name: true, slug: true },
        },
        initiatedByUser: {
          columns: { id: true, name: true, email: true },
        },
        respondedByUser: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    const tagged = transfers.map((t) => ({
      ...t,
      direction: t.sourceOrgId === orgId ? "outgoing" : "incoming",
    }));

    return NextResponse.json({ transfers: tagged });
  } catch (error) {
    return handleRouteError(error, "Error listing transfers");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/transfers" });
