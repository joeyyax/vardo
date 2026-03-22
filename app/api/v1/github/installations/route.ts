import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getAppOctokit } from "@/lib/github/app";

// GET /api/v1/github/installations — List current user's GitHub installations
export async function GET() {
  try {
    const session = await requireSession();

    const installations = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.userId, session.user.id),
    });

    return NextResponse.json({ installations });
  } catch (error) {
    return handleRouteError(error, "Error fetching GitHub installations");
  }
}

// DELETE /api/v1/github/installations — Remove a GitHub installation
export async function DELETE(request: NextRequest) {
  try {
    const session = await requireSession();

    const { id } = await request.json();
    if (!id) {
      return NextResponse.json(
        { error: "Installation id is required" },
        { status: 400 }
      );
    }

    // Find the installation (must belong to current user)
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, id),
        eq(githubAppInstallations.userId, session.user.id)
      ),
    });

    if (!installation) {
      return NextResponse.json(
        { error: "Installation not found" },
        { status: 404 }
      );
    }

    // Remove from our database
    await db
      .delete(githubAppInstallations)
      .where(eq(githubAppInstallations.id, id));

    // Attempt to remove from GitHub (best-effort)
    try {
      const octokit = getAppOctokit();
      await octokit.rest.apps.deleteInstallation({
        installation_id: installation.installationId,
      });
    } catch {
      // GitHub may have already removed it
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting GitHub installation");
  }
}
