import { NextRequest, NextResponse } from "next/server";
import { getCurrentOrg } from "@/lib/auth/session";
import { previewTogglImport } from "@/lib/integrations/toggl";
import { db } from "@/lib/db";
import { clients } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

type RouteContext = {
  params: Promise<{ orgId: string }>;
};

/**
 * POST /api/v1/organizations/[orgId]/integrations/toggl/preview
 * Preview data that will be imported from Toggl
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const orgData = await getCurrentOrg();

  if (!orgData || orgData.organization.id !== orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { token, workspaceId, dateRange } = body;

    if (!token || typeof token !== "string") {
      return NextResponse.json(
        { error: "API token is required" },
        { status: 400 }
      );
    }

    if (!workspaceId || typeof workspaceId !== "number") {
      return NextResponse.json(
        { error: "Workspace ID is required" },
        { status: 400 }
      );
    }

    // Get existing clients for mapping suggestions
    const existingClients = await db.query.clients.findMany({
      where: eq(clients.organizationId, orgId),
    });

    // Fetch Toggl data
    const preview = await previewTogglImport(token, workspaceId, dateRange);

    // Generate mapping suggestions
    const clientMappings = preview.clients.map((togglClient) => {
      // Try to find a matching client by name
      const matchingClient = existingClients.find(
        (c) => c.name.toLowerCase() === togglClient.name.toLowerCase()
      );

      return {
        togglId: togglClient.id,
        togglName: togglClient.name,
        suggestedAction: matchingClient ? "map" : "create",
        suggestedTargetId: matchingClient?.id,
        suggestedTargetName: matchingClient?.name,
      };
    });

    return NextResponse.json({
      workspace: {
        id: preview.workspace.id,
        name: preview.workspace.name,
      },
      counts: {
        clients: preview.clients.length,
        projects: preview.projects.length,
        entries: preview.entryCount,
      },
      dateRange: preview.dateRange,
      togglClients: preview.clients.map((c) => ({
        id: c.id,
        name: c.name,
      })),
      togglProjects: preview.projects.map((p) => ({
        id: p.id,
        name: p.name,
        clientId: p.cid,
        billable: p.billable,
        rate: p.rate,
      })),
      existingClients: existingClients.map((c) => ({
        id: c.id,
        name: c.name,
        color: c.color,
      })),
      suggestedMappings: clientMappings,
    });
  } catch (error) {
    console.error("Error previewing Toggl import:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Preview failed" },
      { status: 500 }
    );
  }
}
