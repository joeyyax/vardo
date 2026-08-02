import { NextRequest, NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { buildAttentionRows } from "@/lib/attention/rows";
import { getSession } from "@/lib/auth/session";

type RouteParams = { params: Promise<{ orgId: string }> };

// GET — every notice for this org, for the chrome that renders on every page.
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { orgId } = await params;
  try {
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const session = await getSession();
    const rows = await buildAttentionRows(orgId, {
      isAppAdmin: !!session?.user?.isAppAdmin,
    });

    return NextResponse.json({ rows });
  } catch (error) {
    return handleRouteError(error, "Error reading attention rows");
  }
}
