import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireSession } from "@/lib/auth/session";
import { createInstallationState } from "@/lib/git-integration/app";
import { getGitHubAppConfig } from "@/lib/system-settings";

// GET /api/v1/github/connect — Generate GitHub App install URL for current user
export async function GET() {
  try {
    const session = await requireSession();

    const githubConfig = await getGitHubAppConfig();
    const slug = githubConfig?.appSlug;
    if (!slug) {
      return NextResponse.json(
        { error: "GitHub App not configured" },
        { status: 503 }
      );
    }

    const state = createInstallationState(session.user.id);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const redirectUri = `${appUrl}/api/v1/github/callback`;
    const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`;

    return NextResponse.json({ url });
  } catch (error) {
    return handleRouteError(error, "Error generating GitHub connect URL");
  }
}
