import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { deployProject } from "@/lib/docker/deploy";
import { createPreview, destroyPreview } from "@/lib/docker/preview";

// POST /api/v1/github/webhook — GitHub App webhook receiver
export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const event = request.headers.get("x-github-event");
    const signature = request.headers.get("x-hub-signature-256");

    // Verify webhook signature
    const secret = process.env.GITHUB_WEBHOOK_SECRET || process.env.BETTER_AUTH_SECRET;
    if (secret && signature) {
      const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
      if (signature !== expected) {
        console.error("[webhook] Invalid signature");
        return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
      }
    }

    const payload = JSON.parse(body);

    // Handle pull request events (previews)
    if (event === "pull_request") {
      return handlePullRequest(payload);
    }

    // Handle push events (auto-deploy)
    if (event === "push") {
      return handlePush(payload);
    }

    return NextResponse.json({ ok: true, skipped: event });
  } catch (error) {
    console.error("[webhook] Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

async function handlePush(payload: Record<string, unknown>): Promise<NextResponse> {
  const repoFullName = (payload.repository as Record<string, unknown>)?.full_name as string;
  const branch = (payload.ref as string)?.replace("refs/heads/", "");
  const commitSha = payload.after as string;
  const commitMessage = (payload.head_commit as Record<string, unknown>)?.message as string;
  const pusher = (payload.pusher as Record<string, unknown>)?.name as string
    || (payload.sender as Record<string, unknown>)?.login as string;

  if (!repoFullName || !branch) {
    return NextResponse.json({ ok: true, skipped: "missing repo or branch" });
  }

  console.log(`[webhook] Push to ${repoFullName}:${branch} by ${pusher} — ${commitSha?.slice(0, 7)} ${commitMessage?.split("\n")[0]}`);

  // Find all apps that match this repo + branch with autoDeploy enabled
  const gitUrl = `https://github.com/${repoFullName}.git`;
  const allApps = await db.query.apps.findMany({
    where: and(
      eq(apps.gitUrl, gitUrl),
      eq(apps.autoDeploy, true)
    ),
  });

  // Filter to matching branch
  const matching = allApps.filter(
    (a) => (a.gitBranch || "main") === branch
  );

  if (matching.length === 0) {
    console.log(`[webhook] No auto-deploy apps for ${repoFullName}:${branch}`);
    return NextResponse.json({ ok: true, skipped: "no matching apps" });
  }

  // Trigger deploys
  const results = [];
  for (const app of matching) {
    console.log(`[webhook] Auto-deploying ${app.displayName} (${app.name})`);
    try {
      const result = await deployProject({
        appId: app.id,
        organizationId: app.organizationId,
        trigger: "webhook",
      });
      results.push({
        app: app.name,
        deploymentId: result.deploymentId,
        success: result.success,
      });
    } catch (err) {
      results.push({
        app: app.name,
        error: err instanceof Error ? err.message : "Deploy failed",
      });
    }
  }

  return NextResponse.json({ ok: true, deployments: results });
}

async function handlePullRequest(payload: Record<string, unknown>): Promise<NextResponse> {
  const action = payload.action as string;
  const pr = payload.pull_request as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;

  if (!pr || !repo) {
    return NextResponse.json({ ok: true, skipped: "missing PR data" });
  }

  const repoFullName = repo.full_name as string;
  const prNumber = pr.number as number;
  const prUrl = pr.html_url as string;
  const branch = (pr.head as Record<string, unknown>)?.ref as string;
  const author = (pr.user as Record<string, unknown>)?.login as string;

  console.log(`[webhook] PR #${prNumber} ${action} on ${repoFullName}:${branch} by ${author}`);

  if (action === "opened" || action === "reopened" || action === "synchronize") {
    // Create or update preview
    try {
      const result = await createPreview({
        repoFullName,
        prNumber,
        prUrl,
        branch,
        author,
      });

      if (!result) {
        console.log(`[webhook] No grouped project found for ${repoFullName}:${branch}`);
        return NextResponse.json({ ok: true, skipped: "no grouped project" });
      }

      // Post preview URLs as PR comment
      if (result.domains.length > 0) {
        try {
          await postPreviewComment(repoFullName, prNumber, result.domains);
        } catch (err) {
          console.error("[webhook] Failed to post PR comment:", err);
        }
      }

      return NextResponse.json({
        ok: true,
        preview: {
          groupEnvironmentId: result.groupEnvironmentId,
          domains: result.domains,
          deployed: result.deployed,
        },
      });
    } catch (err) {
      console.error(`[webhook] Preview creation failed for PR #${prNumber}:`, err);
      return NextResponse.json({ ok: true, error: "Preview creation failed" });
    }
  }

  if (action === "closed") {
    // Destroy preview
    try {
      const destroyed = await destroyPreview(repoFullName, prNumber);
      console.log(`[webhook] Preview for PR #${prNumber} ${destroyed ? "destroyed" : "not found"}`);
      return NextResponse.json({ ok: true, destroyed });
    } catch (err) {
      console.error(`[webhook] Preview cleanup failed for PR #${prNumber}:`, err);
      return NextResponse.json({ ok: true, error: "Preview cleanup failed" });
    }
  }

  return NextResponse.json({ ok: true, skipped: `PR action: ${action}` });
}

/**
 * Post preview environment URLs as a GitHub PR comment.
 */
async function postPreviewComment(
  repoFullName: string,
  prNumber: number,
  previewDomains: { appName: string; domain: string }[]
): Promise<void> {
  const { getInstallationToken } = await import("@/lib/github/app");
  const { githubAppInstallations, memberships } = await import("@/lib/db/schema");

  // Find a GitHub installation token for this repo
  // Look through all users' installations to find one with access
  const allInstallations = await db.query.githubAppInstallations.findMany();

  let token: string | null = null;
  for (const inst of allInstallations) {
    try {
      token = await getInstallationToken(inst.installationId);
      break;
    } catch { /* try next */ }
  }

  if (!token) {
    console.log("[webhook] No GitHub token available for PR comment");
    return;
  }

  const lines = [
    "## Preview Environment",
    "",
    "| Service | URL |",
    "|---------|-----|",
    ...previewDomains.map(
      (d) => `| ${d.appName} | https://${d.domain} |`
    ),
    "",
    "_Deployed by [Host](https://github.com/joeyyax/host)_",
  ];

  const response = await fetch(
    `https://api.github.com/repos/${repoFullName}/issues/${prNumber}/comments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: lines.join("\n") }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text}`);
  }
}
