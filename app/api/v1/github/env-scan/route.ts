import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { githubAppInstallations } from "@/lib/db/schema";
import { requireSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { getInstallationOctokit } from "@/lib/git-integration/app";
import { logger } from "@/lib/logger";

const log = logger.child("github:env-scan");

const ENV_CANDIDATES = [".env.example", ".env.sample", ".env.template"];

interface EnvVar {
  key: string;
  defaultValue: string | null;
}

function parseEnvFile(content: string): EnvVar[] {
  const vars: EnvVar[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.trim();

    // Skip blank lines and comments
    if (!line || line.startsWith("#")) continue;

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      // Bare key with no `=`
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(line)) {
        vars.push({ key: line, defaultValue: null });
      }
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    if (!key) continue;

    const rawValue = line.slice(eqIndex + 1).trim();
    // Strip surrounding quotes if present
    const value = rawValue.replace(/^["']|["']$/g, "");
    vars.push({ key, defaultValue: value || null });
  }

  return vars;
}

// GET /api/v1/github/env-scan?installationId=X&repo=owner/repo&branch=main&rootDirectory=apps/web
export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();

    const searchParams = request.nextUrl.searchParams;
    const installationId = searchParams.get("installationId");
    const repo = searchParams.get("repo");
    const branch = searchParams.get("branch") || undefined;
    const rootDirectory = searchParams.get("rootDirectory") || undefined;

    if (!installationId) {
      return NextResponse.json(
        { error: "installationId query param is required" },
        { status: 400 }
      );
    }

    if (!repo) {
      return NextResponse.json(
        { error: "repo query param is required" },
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

    const octokit = await getInstallationOctokit(installation.installationId);
    const [owner, repoName] = repo.split("/");

    if (!owner || !repoName) {
      return NextResponse.json(
        { error: "repo must be in owner/repo format" },
        { status: 400 }
      );
    }

    // Try each candidate filename, stop at first found
    for (const filename of ENV_CANDIDATES) {
      const path = rootDirectory
        ? `${rootDirectory.replace(/\/$/, "")}/${filename}`
        : filename;

      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo: repoName,
          path,
          ...(branch ? { ref: branch } : {}),
        });

        // getContent can return a directory listing — we only want files
        if (Array.isArray(data) || data.type !== "file" || !data.content) {
          continue;
        }

        const decoded = Buffer.from(data.content, "base64").toString("utf-8");
        const envVars = parseEnvFile(decoded);

        return NextResponse.json({ envVars, filename });
      } catch (err: unknown) {
        // 404 means file doesn't exist — try the next candidate
        if (
          err &&
          typeof err === "object" &&
          "status" in err &&
          (err as { status: number }).status === 404
        ) {
          continue;
        }
        throw err;
      }
    }

    // No env template file found
    return NextResponse.json({ envVars: [], filename: null });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    log.error("Error scanning for env files:", error);
    return NextResponse.json(
      { error: "Failed to scan repository for env files" },
      { status: 502 }
    );
  }
}
