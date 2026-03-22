import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, memberships, githubAppInstallations } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getInstallationOctokit } from "@/lib/github/app";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps/[appId]/branches
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const app = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, appId),
        eq(apps.organizationId, orgId),
      ),
      columns: { id: true, gitUrl: true, source: true },
    });

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (app.source !== "git" || !app.gitUrl) {
      return NextResponse.json({ branches: [] });
    }

    // Extract owner/repo from git URL (handles both HTTPS and SSH)
    let owner: string | null = null;
    let repo: string | null = null;

    // Try HTTPS: https://github.com/owner/repo.git
    const httpsMatch = app.gitUrl.match(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    if (httpsMatch) {
      owner = httpsMatch[1];
      repo = httpsMatch[2];
    }

    // Try SSH: git@github.com:owner/repo.git
    if (!owner) {
      const sshMatch = app.gitUrl.match(/github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
      if (sshMatch) {
        owner = sshMatch[1];
        repo = sshMatch[2];
      }
    }

    if (!owner || !repo) {
      return NextResponse.json({ branches: [] });
    }

    // Find a working GitHub installation — same approach as deploy engine
    const orgMembers = await db.query.memberships.findMany({
      where: eq(memberships.organizationId, orgId),
      columns: { userId: true },
    });
    const userIds = orgMembers.map((m) => m.userId);

    for (const userId of userIds) {
      const installations = await db.query.githubAppInstallations.findMany({
        where: eq(githubAppInstallations.userId, userId),
      });

      for (const inst of installations) {
        try {
          const octokit = getInstallationOctokit(inst.installationId);
          const { data } = await octokit.rest.repos.listBranches({
            owner,
            repo,
            per_page: 100,
          });
          return NextResponse.json({ branches: data.map((b) => b.name) });
        } catch {
          // This installation doesn't have access to this repo, try next
        }
      }
    }

    // No installation found or none had access
    return NextResponse.json({ branches: [] });
  } catch (error) {
    return handleRouteError(error, "Error fetching branches");
  }
}
