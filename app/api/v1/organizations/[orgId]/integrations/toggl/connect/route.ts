import { NextRequest, NextResponse } from "next/server";
import { getCurrentOrg } from "@/lib/auth/session";
import { validateTogglToken, fetchTogglWorkspaces } from "@/lib/integrations/toggl";

type RouteContext = {
  params: Promise<{ orgId: string }>;
};

/**
 * POST /api/v1/organizations/[orgId]/integrations/toggl/connect
 * Validate Toggl API token and return available workspaces
 */
export async function POST(request: NextRequest, context: RouteContext) {
  const { orgId } = await context.params;
  const orgData = await getCurrentOrg();

  if (!orgData || orgData.organization.id !== orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    const { token } = body;

    if (!token || typeof token !== "string") {
      return NextResponse.json(
        { error: "API token is required" },
        { status: 400 }
      );
    }

    // Validate the token
    const validation = await validateTogglToken(token);

    if (!validation.valid) {
      return NextResponse.json(
        { error: validation.error || "Invalid API token" },
        { status: 400 }
      );
    }

    // Fetch workspaces
    const workspaces = await fetchTogglWorkspaces(token);

    return NextResponse.json({
      valid: true,
      user: {
        email: validation.user?.email,
        name: validation.user?.fullname,
      },
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
      })),
      defaultWorkspaceId: validation.user?.default_workspace_id,
    });
  } catch (error) {
    console.error("Error connecting to Toggl:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Connection failed" },
      { status: 500 }
    );
  }
}
