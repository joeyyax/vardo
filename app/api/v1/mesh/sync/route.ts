import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { requireMeshPeer } from "@/lib/mesh/auth";
import { getInstanceId } from "@/lib/constants";

/**
 * GET /api/v1/mesh/sync — return this instance's project manifest.
 *
 * Authenticated via mesh bearer token. Returns a lightweight snapshot
 * of projects and apps for the requesting peer to cache locally.
 */
export async function GET(request: NextRequest) {
  try {
    await requireMeshPeer(request);

    const projects = await db.query.projects.findMany({
      columns: {
        id: true,
        name: true,
        displayName: true,
        organizationId: true,
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
      instanceId: getInstanceId(),
      syncedAt: new Date().toISOString(),
      projects,
    });
  } catch (error) {
    return handleRouteError(error, "Error generating sync manifest");
  }
}
