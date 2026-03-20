import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getInstallationOctokit } from "@/lib/github/app";

// GET /api/v1/github/branches?installationId=X&repo=owner/repo
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();

    const installationId = request.nextUrl.searchParams.get("installationId");
    const repo = request.nextUrl.searchParams.get("repo");

    if (!installationId || !repo) {
      return NextResponse.json(
        { error: "installationId and repo are required" },
        { status: 400 }
      );
    }

    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, installationId),
        eq(githubAppInstallations.userId, session.user.id)
      ),
    });

    if (!installation) {
      return NextResponse.json({ error: "Installation not found" }, { status: 404 });
    }

    const octokit = getInstallationOctokit(installation.installationId);
    const [owner, repoName] = repo.split("/");

    if (!owner || !repoName) {
      return NextResponse.json({ error: "repo must be owner/repo format" }, { status: 400 });
    }

    const { data } = await octokit.rest.repos.listBranches({
      owner,
      repo: repoName,
      per_page: 100,
    });

    const branches = data.map((b) => b.name);

    return NextResponse.json({ branches });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching branches:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
