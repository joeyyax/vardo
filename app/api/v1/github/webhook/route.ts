import { NextRequest, NextResponse, after } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { createPreview, destroyPreview } from "@/lib/docker/preview";
import { getSystemManagedApp, createVardoPreview, destroyVardoPreview } from "@/lib/docker/self-preview";
import { isFeatureEnabled, isFeatureEnabledAsync } from "@/lib/config/features";
import { getGitHubAppConfig } from "@/lib/system-settings";
import { previewRefusalReason } from "@/lib/git-integration/pull-request";
import { logger } from "@/lib/logger";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const log = logger.child("webhook");

// POST /api/v1/github/webhook: GitHub App webhook receiver.
async function handler(request: NextRequest) {
  // Preview instances receive the same webhooks and must not spawn further previews.
  if (process.env.VARDO_PREVIEW === "true") {
    return NextResponse.json({ ok: true, skipped: "preview instance" });
  }

  const gate = await requirePlugin("git-integration");
  if (gate) return gate;

  try {
    const body = await request.text();
    const event = request.headers.get("x-github-event");
    const signature = request.headers.get("x-hub-signature-256");

    // Signature is mandatory. DB config, then GITHUB_WEBHOOK_SECRET; never fall back to BETTER_AUTH_SECRET.
    const githubConfig = await getGitHubAppConfig();
    const secret = githubConfig?.webhookSecret;
    if (!secret) {
      log.error("GitHub webhook secret not configured — set it in Settings > GitHub");
      return NextResponse.json(
        { error: "Webhook not configured: GitHub webhook secret is required" },
        { status: 500 }
      );
    }
    if (!signature) {
      log.error("Missing signature header");
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      log.error("Invalid signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const payload = JSON.parse(body);

    if (event === "pull_request") {
      return handlePullRequest(payload);
    }

    if (event === "push") {
      return handlePush(payload);
    }

    return NextResponse.json({ ok: true, skipped: event });
  } catch (error) {
    log.error("Error:", error);
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

  log.info(`Push to ${repoFullName}:${branch} by ${pusher} — ${commitSha?.slice(0, 7)} ${commitMessage?.split("\n")[0]}`);

  const gitUrl = `https://github.com/${repoFullName}.git`;
  const allApps = await db.query.apps.findMany({
    where: and(
      eq(apps.gitUrl, gitUrl),
      eq(apps.autoDeploy, true)
    ),
  });

  // System-managed apps go through the self-preview path, never the generic deploy engine.
  const matching = allApps.filter(
    (a) => !a.isSystemManaged && (a.gitBranch || "main") === branch
  );

  if (matching.length === 0) {
    log.info(`No auto-deploy apps for ${repoFullName}:${branch}`);
    return NextResponse.json({ ok: true, skipped: "no matching apps" });
  }

  const results = [];
  for (const app of matching) {
    log.info(`Auto-deploying ${app.displayName} (${app.name})`);
    try {
      const result = await requestDeploy({
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

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    log.error(`Invalid PR number in webhook payload: ${prNumber}`);
    return NextResponse.json({ ok: true, skipped: "invalid PR number" });
  }

  // Fork PRs are signed like any other; building them would let outsiders trigger deploys.
  // Teardown stays below this so a PR that became a fork still gets cleaned up.
  const headRepo = (pr.head as Record<string, unknown>)?.repo as Record<string, unknown> | null;
  const refusal = action === "closed" ? null : previewRefusalReason({
    baseRepoFullName: repoFullName,
    headRepoFullName: headRepo?.full_name as string | undefined,
    headIsFork: headRepo?.fork as boolean | undefined,
  });
  if (refusal) {
    log.info(`PR #${prNumber} skipped — ${refusal}`);
    return NextResponse.json({ ok: true, skipped: refusal });
  }

  log.info(`PR #${prNumber} ${action} on ${repoFullName}:${branch} by ${author}`);

  // Previews off: a close still removes an existing preview, touching only resources labeled as that PR's.
  const previewsEnabled = await isFeatureEnabledAsync("previews");
  if (!previewsEnabled && action === "closed") {
    log.info(`Previews are off; PR #${prNumber} closed, removing any existing preview`);
  }

  // System-managed repos get a frontend-only self-preview when selfManagement is on.
  if (isFeatureEnabled("selfManagement")) {
    const vardoApp = await getSystemManagedApp(repoFullName);
    if (vardoApp) {
      if (previewsEnabled && (action === "opened" || action === "reopened" || action === "synchronize")) {
        try {
          const result = await createVardoPreview({ prNumber, branch, repoFullName });
          try {
            await postPreviewComment(repoFullName, prNumber, [
              { appName: "vardo", domain: result.domain },
            ]);
          } catch (err) {
            log.error("Failed to post PR comment:", err);
          }
          return NextResponse.json({ ok: true, preview: result });
        } catch (err) {
          log.error(`Vardo preview creation failed for PR #${prNumber}:`, err);
          return NextResponse.json({ ok: true, error: "Vardo preview creation failed" });
        }
      }
      if (action === "closed") {
        try {
          await destroyVardoPreview(prNumber);
          log.info(`Vardo preview for PR #${prNumber} destroyed`);
        } catch (err) {
          log.error(`Vardo preview cleanup failed for PR #${prNumber}:`, err);
        }
        return NextResponse.json({ ok: true, destroyed: true });
      }
      return NextResponse.json({
        ok: true,
        skipped: previewsEnabled ? `PR action: ${action}` : "previews disabled",
      });
    }
  }

  // Runs after the response; GitHub times out after ten seconds. preview.ts serializes per PR.
  if (previewsEnabled && (action === "opened" || action === "reopened" || action === "synchronize")) {
    after(async () => {
      try {
        const result = await createPreview({
          repoFullName,
          prNumber,
          prUrl,
          branch,
          author,
        });

        if (!result) {
          log.info(`No preview for ${repoFullName}#${prNumber} (no grouped project, or closed meanwhile)`);
          return;
        }

        if (result.domains.length > 0) {
          try {
            await postPreviewComment(repoFullName, prNumber, result.domains);
          } catch (err) {
            log.error("Failed to post PR comment:", err);
          }
        }
      } catch (err) {
        log.error(`Preview creation failed for PR #${prNumber}:`, err);
      }
    });
    return NextResponse.json({ ok: true, accepted: "preview" }, { status: 202 });
  }

  if (action === "closed") {
    after(async () => {
      try {
        const destroyed = await destroyPreview(repoFullName, prNumber);
        log.info(`Preview for PR #${prNumber} ${destroyed ? "destroyed" : "not found"}`);
      } catch (err) {
        log.error(`Preview cleanup failed for PR #${prNumber}:`, err);
      }
    });
    return NextResponse.json({ ok: true, accepted: "teardown" }, { status: 202 });
  }

  return NextResponse.json({
    ok: true,
    skipped: previewsEnabled ? `PR action: ${action}` : "previews disabled",
  });
}

export const POST = withRateLimit(handler, { tier: "public", key: "webhook" });

/** Posts preview environment URLs as a GitHub PR comment. */
async function postPreviewComment(
  repoFullName: string,
  prNumber: number,
  previewDomains: { appName: string; domain: string }[]
): Promise<void> {
  const { getInstallationToken } = await import("@/lib/git-integration/app");

  // First installation token with access to this repo.
  const allInstallations = await db.query.githubAppInstallations.findMany();

  let token: string | null = null;
  for (const inst of allInstallations) {
    try {
      token = await getInstallationToken(inst.installationId);
      break;
    } catch { /* try next */ }
  }

  if (!token) {
    log.info("No GitHub token available for PR comment");
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
    "_Deployed by [Vardo](https://vardo.run)_",
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
