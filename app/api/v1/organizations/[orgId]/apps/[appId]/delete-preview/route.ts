import { NextRequest, NextResponse } from "next/server";
import { and, eq, ne, isNull, or } from "drizzle-orm";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { findAppData, measureAppData } from "@/lib/docker/app-data";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/delete-preview
// What deleting the app would destroy or keep. `?sizes=1` adds sizes.
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const org = await verifyOrgAccess(orgId, "app.delete");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.id, appId), eq(apps.organizationId, orgId)),
      columns: { id: true, name: true, parentAppId: true, projectId: true },
      with: { project: { columns: { id: true, name: true, displayName: true } } },
    });
    if (!app) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (request.nextUrl.searchParams.get("sizes") === "1") {
      return NextResponse.json(await measureAppData(await findAppData(app)));
    }

    let project: { id: string; name: string } | null = null;
    if (app.project) {
      // The app's compose children go with it.
      const other = await db.query.apps.findFirst({
        where: and(
          eq(apps.projectId, app.project.id),
          ne(apps.id, appId),
          or(isNull(apps.parentAppId), ne(apps.parentAppId, appId)),
        ),
        columns: { id: true },
      });
      if (!other) {
        project = { id: app.project.id, name: app.project.displayName || app.project.name };
      }
    }

    return NextResponse.json({ ...(await findAppData(app)), project });
  } catch (error) {
    return handleRouteError(error, "Error previewing app delete");
  }
}
