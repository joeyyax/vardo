import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { listContainers } from "@/lib/docker/client";
import { verifyOrgAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/containers
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const containers = await listContainers(app.name);
    const running = containers
      .filter((c) => c.state === "running")
      .map((c) => ({
        id: c.id,
        name: c.name,
        image: c.image,
        state: c.state,
        status: c.status,
      }));

    return NextResponse.json({ containers: running });
  } catch (error) {
    return handleRouteError(error, "Error listing containers");
  }
}
