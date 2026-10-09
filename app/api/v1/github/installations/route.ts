import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { githubAppInstallations, githubInstallationOrgs } from "@/lib/db/schema";
import { requireSession, getCurrentOrg, isScopedToken } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { getAppOctokit } from "@/lib/git-integration/app";

import { withRateLimit } from "@/lib/api/with-rate-limit";

// GET /api/v1/github/installations — List current user's GitHub installations
async function handleGet() {
  try {
    const session = await requireSession();

    const rows = await db.query.githubAppInstallations.findMany({
      where: eq(githubAppInstallations.userId, session.user.id),
    });

    // Link state against the current org, which clones and push webhooks are scoped to.
    const current = await getCurrentOrg();
    const linkedIds = new Set(
      current
        ? (
            await db.query.githubInstallationOrgs.findMany({
              where: eq(githubInstallationOrgs.organizationId, current.organization.id),
              columns: { installationId: true },
            })
          ).map((l) => l.installationId)
        : [],
    );
    const installations = rows.map((r) => ({ ...r, linkedToOrg: linkedIds.has(r.installationId) }));
    const organization = current
      ? {
          id: current.organization.id,
          name: current.organization.name,
          canManage: can(current.membership, "org.settings"),
        }
      : null;

    return NextResponse.json({ installations, organization });
  } catch (error) {
    return handleRouteError(error, "Error fetching GitHub installations");
  }
}

// DELETE /api/v1/github/installations — Remove a GitHub installation
async function handleDelete(request: NextRequest) {
  try {
    const session = await requireSession();
    // A scoped token only acts through org capabilities.
    if (isScopedToken(session)) return apiError.forbidden();

    const { id } = await request.json();
    if (!id) {
      return NextResponse.json(
        { error: "Installation id is required" },
        { status: 400 }
      );
    }

    // Must belong to the current user.
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

    await db
      .delete(githubAppInstallations)
      .where(eq(githubAppInstallations.id, id));
    // The installation is removed on GitHub too, so no org keeps it.
    await db
      .delete(githubInstallationOrgs)
      .where(eq(githubInstallationOrgs.installationId, installation.installationId));

    // Best-effort removal on GitHub.
    try {
      const octokit = await getAppOctokit();
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

export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "github-installations" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/github/installations" });
