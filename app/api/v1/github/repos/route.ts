import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { requireSession, isScopedToken } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { listInstallationRepos, createRepo } from "@/lib/git-integration/app";
import { z } from "zod";
import { logger } from "@/lib/logger";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError } from "@/lib/api/error-response";

const log = logger.child("github:repos");

// GET /api/v1/github/repos?installationId=X — List repos for a user's installation
async function handleGet(request: NextRequest) {
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
      return apiError.unauthorized();
    }
    log.error("Error fetching GitHub repos:", error);
    return NextResponse.json(
      { error: "Couldn't fetch repositories from GitHub" },
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
async function handlePost(request: NextRequest) {
  try {
    const session = await requireSession();
    // A scoped token only acts through org capabilities.
    if (isScopedToken(session)) return apiError.forbidden();

    const body = await request.json();
    const parsed = createRepoSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
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
      return apiError.unauthorized();
    }
    log.error("Error creating GitHub repo:", error);
    return NextResponse.json(
      { error: "Couldn't create repository" },
      { status: 502 }
    );
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "github-repos" });

export const GET = withRateLimit(handleGet, { tier: "heavy", key: "get:v1/github/repos" });
