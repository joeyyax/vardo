import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { listInstallationRepos, createRepo } from "@/lib/github/app";
import { z } from "zod";

// GET /api/v1/github/repos?installationId=X — List repos for a user's installation
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();

    const installationId = request.nextUrl.searchParams.get("installationId");
    if (!installationId) {
      return NextResponse.json(
        { error: "installationId query param is required" },
        { status: 400 }
      );
    }

    // Verify the installation belongs to the current user
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, installationId),
        eq(githubAppInstallations.userId, session.user.id)
      ),
    });

    if (!installation) {
      return NextResponse.json(
        { error: "Installation not found" },
        { status: 404 }
      );
    }

    const repos = await listInstallationRepos(installation.installationId);

    return NextResponse.json({ repos });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching GitHub repos:", error);
    return NextResponse.json(
      { error: "Failed to fetch repositories from GitHub" },
      { status: 502 }
    );
  }
}

const createRepoSchema = z.object({
  installationId: z.string().min(1),
  name: z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/, "Invalid repo name"),
  description: z.string().optional(),
  isPrivate: z.boolean().default(true),
}).strict();

// POST /api/v1/github/repos — Create a new repository
export async function POST(request: NextRequest) {
  try {
    const session = await requireSession();

    const body = await request.json();
    const parsed = createRepoSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const { installationId, name, description, isPrivate } = parsed.data;

    // Verify the installation belongs to the current user
    const installation = await db.query.githubAppInstallations.findFirst({
      where: and(
        eq(githubAppInstallations.id, installationId),
        eq(githubAppInstallations.userId, session.user.id)
      ),
    });

    if (!installation) {
      return NextResponse.json(
        { error: "Installation not found" },
        { status: 404 }
      );
    }

    const repo = await createRepo(installation.installationId, {
      name,
      description,
      isPrivate,
      owner: installation.accountLogin,
      ownerType: installation.accountType as "User" | "Organization",
    });

    return NextResponse.json({ repo }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating GitHub repo:", error);
    return NextResponse.json(
      { error: "Failed to create repository" },
      { status: 502 }
    );
  }
}
