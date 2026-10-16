// Deploys and previews for a push or pull_request event, shared by GitHub's webhook and the mesh relay.

import { NextResponse, after } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { enqueueDeploy } from "@/lib/deploy/queue";
import { createPreview, destroyPreview } from "@/lib/docker/preview";
import { getSystemManagedApp, createVardoPreview, destroyVardoPreview } from "@/lib/docker/self-preview";
import { isFeatureEnabled, isFeatureEnabledAsync } from "@/lib/config/features";
import { previewRefusalReason } from "@/lib/git-integration/pull-request";
import { logger } from "@/lib/logger";
import { previewLive, previewRemoved } from "./github-feedback";
import type { PullRequestEvent, PushEvent } from "./webhook-event";

const log = logger.child("webhook");

export type MatchedApp = { id: string; name: string; organizationId: string };

export type EventScope = {
  trigger: "webhook" | "relay";
  /** Orgs whose apps the event may deploy, or why it deploys nothing. */
  resolveOrgs: () => Promise<{ orgIds: string[] } | { skipped: string }>;
  onMatched?: (apps: MatchedApp[]) => void | Promise<void>;
};

/** A push's `after` when it names a commit; a branch deletion sends all zeros. */
export function pushedSha(sha: string | null | undefined): string | undefined {
  return sha && /^[0-9a-f]{40}$/i.test(sha) && !/^0+$/.test(sha) ? sha : undefined;
}

/** Auto-deploy apps whose git URL and branch match the push. */
export async function handlePushEvent(event: PushEvent, scope: EventScope): Promise<NextResponse> {
  const { repoFullName, branch, headSha } = event;
  log.info(
    `Push to ${repoFullName}:${branch}${event.pusher ? ` by ${event.pusher}` : ""} — ${headSha?.slice(0, 7)} ${event.commitMessage?.split("\n")[0] ?? ""}${scope.trigger === "relay" ? " (relayed)" : ""}`,
  );

  // Nothing to deploy. A PR's preview is removed by its pull_request close, not by this push.
  if (event.deleted || (headSha && /^0+$/.test(headSha))) {
    log.info(`Branch ${repoFullName}:${branch} deleted; nothing to deploy`);
    return NextResponse.json({ ok: true, skipped: "branch deleted" });
  }

  const orgs = await scope.resolveOrgs();
  if ("skipped" in orgs) {
    return NextResponse.json({ ok: true, skipped: orgs.skipped });
  }

  if (repoFullName === "joeyyax/vardo" && branch === "main") {
    after(async () => {
      const { invalidateChannelUpdate } = await import("@/lib/version");
      invalidateChannelUpdate("main");
      const { tickSelfUpdate } = await import("@/lib/self-update/runner");
      await tickSelfUpdate();
    });
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

  const results = [];
  for (const app of matching) {
    log.info(`Auto-deploying ${app.displayName} (${app.name})`);
    try {
      const { id } = await enqueueDeploy({
        appId: app.id,
        trigger: scope.trigger,
        // The pushed commit, not whatever the branch points at when the deploy clones.
        gitSha: pushedSha(headSha),
        pinIntent: "push",
      });
      results.push({ app: app.name, deploymentId: id });
    } catch (err) {
      results.push({ app: app.name, error: err instanceof Error ? err.message : "Couldn't queue the deploy" });
    }
  }
  return NextResponse.json({ ok: true, accepted: matching.map((a) => a.name), deployments: results }, { status: 202 });
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
      const selfPreviews = previewsEnabled && (await isFeatureEnabledAsync("selfPreviews"));
      if (selfPreviews && (action === "opened" || action === "reopened" || action === "synchronize")) {
        try {
          const result = await createVardoPreview({ prNumber, branch, repoFullName });
          void previewLive(repoFullName, prNumber, [{ appName: "vardo", domain: result.domain }]);
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
          void previewRemoved(repoFullName, prNumber, null);
        } catch (err) {
          log.error(`Vardo preview cleanup failed for PR #${prNumber}:`, err);
        }
        return NextResponse.json({ ok: true, destroyed: true });
      }
      return NextResponse.json({
        ok: true,
        skipped: selfPreviews ? `PR action: ${action}` : "Vardo previews disabled",
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
        if (destroyed) void previewRemoved(repoFullName, prNumber, orgIds);
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
