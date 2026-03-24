import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { getInstanceId } from "@/lib/constants";

/**
 * GET /api/v1/mesh/sync?orgId=xxx — return this instance's project manifest.
 *
 * Authenticated via mesh bearer token. Any authenticated peer can request
 * any org's manifest — this is intentional for hub-spoke topology where
 * the hub is the source of truth and all peers are trusted members of the
 * mesh network (authenticated over WireGuard + bearer token). Org-level
 * ACLs can be added later if multi-tenant peer isolation is needed.
 */
export async function GET(request: NextRequest) {
  try {
    const peer = await requireMeshPeer(request);

    const orgId = request.nextUrl.searchParams.get("orgId");
    if (!orgId) {
      return NextResponse.json(
        { error: "orgId query parameter is required" },
        { status: 400 }
      );
    }

    const orgProjects = await db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      columns: {
        id: true,
        name: true,
        displayName: true,
      },
      with: {
        apps: {
          columns: {
            id: true,
            name: true,
            displayName: true,
            status: true,
            deployType: true,
          },
        },
      },
    });

    return NextResponse.json({
      instanceId: await getInstanceId(),
      peerId: peer.id,
      syncedAt: new Date().toISOString(),
      projects: orgProjects,
    });
  } catch (error) {
    return handleRouteError(error, "Error generating sync manifest");
  }
}
