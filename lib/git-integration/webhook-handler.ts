// Deploys and previews for a push or pull_request event, shared by GitHub's webhook and the mesh relay.

import { NextResponse, after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { requestDeploy } from "@/lib/docker/deploy-cancel";
import { createPreview, destroyPreview } from "@/lib/docker/preview";
import { getSystemManagedApp, createVardoPreview, destroyVardoPreview } from "@/lib/docker/self-preview";
import { isFeatureEnabled, isFeatureEnabledAsync } from "@/lib/config/features";
import { previewRefusalReason } from "@/lib/git-integration/pull-request";
import { logger } from "@/lib/logger";
import type { PullRequestEvent, PushEvent } from "./webhook-event";

const log = logger.child("webhook");

export type MatchedApp = { id: string; name: string; organizationId: string };

export type EventScope = {
  trigger: "webhook" | "relay";
  /** Orgs whose apps the event may deploy, or why it deploys nothing. */
  resolveOrgs: () => Promise<{ orgIds: string[] } | { skipped: string }>;
  /** Await each deploy before answering. The relay answers first. */
  waitForDeploys: boolean;
  onMatched?: (apps: MatchedApp[]) => void | Promise<void>;
};

/** Auto-deploy apps whose git URL and branch match the push. */
export async function handlePushEvent(event: PushEvent, scope: EventScope): Promise<NextResponse> {
  const { repoFullName, branch, headSha } = event;
  log.info(
    `Push to ${repoFullName}:${branch}${event.pusher ? ` by ${event.pusher}` : ""} — ${headSha?.slice(0, 7)} ${event.commitMessage?.split("\n")[0] ?? ""}${scope.trigger === "relay" ? " (relayed)" : ""}`,
  );

  const orgs = await scope.resolveOrgs();
  if ("skipped" in orgs) {
    return NextResponse.json({ ok: true, skipped: orgs.skipped });
  }

  const gitUrl = `https://github.com/${repoFullName}.git`;
  const allApps = await db.query.apps.findMany({
    where: and(
      eq(apps.gitUrl, gitUrl),
      eq(apps.autoDeploy, true),
      inArray(apps.organizationId, orgs.orgIds),
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

  await scope.onMatched?.(matching.map((a) => ({ id: a.id, name: a.name, organizationId: a.organizationId })));

  const deployOne = async (app: (typeof matching)[number]) => {
    log.info(`Auto-deploying ${app.displayName} (${app.name})`);
    try {
      const result = await requestDeploy({
        appId: app.id,
        organizationId: app.organizationId,
        trigger: scope.trigger,
      });
      return { app: app.name, deploymentId: result.deploymentId, success: result.success };
    } catch (err) {
      return { app: app.name, error: err instanceof Error ? err.message : "Deploy failed" };
    }
  };

  if (!scope.waitForDeploys) {
    for (const app of matching) void deployOne(app);
    return NextResponse.json({ ok: true, accepted: matching.map((a) => a.name) }, { status: 202 });
  }

  const results = [];
  for (const app of matching) results.push(await deployOne(app));
  return NextResponse.json({ ok: true, deployments: results });
}

/** Creates, refreshes or tears down preview environments for a pull request. */
export async function handlePullRequestEvent(event: PullRequestEvent, scope: EventScope): Promise<NextResponse> {
  const { action, repoFullName, prNumber, branch, author } = event;
  const prUrl = `https://github.com/${repoFullName}/pull/${prNumber}`;

  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    log.error(`Invalid PR number in webhook payload: ${prNumber}`);
    return NextResponse.json({ ok: true, skipped: "invalid PR number" });
  }

  // Fork PRs are signed like any other; building them would let outsiders trigger deploys.
  // Teardown stays below this so a PR that became a fork still gets cleaned up.
  const refusal = action === "closed" ? null : previewRefusalReason({
    baseRepoFullName: repoFullName,
    headRepoFullName: event.headRepoFullName ?? undefined,
    headIsFork: event.headIsFork ?? undefined,
  });
  if (refusal) {
    log.info(`PR #${prNumber} skipped — ${refusal}`);
    return NextResponse.json({ ok: true, skipped: refusal });
  }

  log.info(`PR #${prNumber} ${action} on ${repoFullName}:${branch} by ${author}${scope.trigger === "relay" ? " (relayed)" : ""}`);

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

  const orgs = await scope.resolveOrgs();
  if ("skipped" in orgs) {
    return NextResponse.json({ ok: true, skipped: orgs.skipped });
  }
  const orgIds = orgs.orgIds;

  // Runs after the response; GitHub times out after ten seconds. preview.ts serializes per PR.
  if (previewsEnabled && (action === "opened" || action === "reopened" || action === "synchronize")) {
    after(async () => {
      try {
        const result = await createPreview({
          repoFullName,
          prNumber,
          prUrl,
          branch,
          author: author ?? undefined,
          organizationIds: orgIds,
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
        const destroyed = await destroyPreview(repoFullName, prNumber, orgIds);
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
