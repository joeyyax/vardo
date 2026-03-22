import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { createInstallationState } from "@/lib/github/app";

// GET /api/v1/github/connect — Generate GitHub App install URL for current user
export async function GET() {
  try {
    const session = await requireSession();

    const slug = process.env.GITHUB_APP_SLUG;
    if (!slug) {
      return NextResponse.json(
        { error: "GitHub App not configured" },
        { status: 503 }
      );
    }

    const state = createInstallationState(session.user.id);
    const url = `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;

    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error generating GitHub connect URL:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
