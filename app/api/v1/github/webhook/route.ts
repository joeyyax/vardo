import { NextRequest, NextResponse, after } from "next/server";
import { getGitHubAppConfig } from "@/lib/system-settings";
import { logger } from "@/lib/logger";
import { orgsForInstallation } from "@/lib/git-integration/org-installations";
import { eventFromGithub, toRelayEvent, verifyGithubSignature, type GitEvent } from "@/lib/git-integration/webhook-event";
import { handlePullRequestEvent, handlePushEvent } from "@/lib/git-integration/webhook-handler";
import { claimDelivery } from "@/lib/git-integration/delivery-dedupe";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

const log = logger.child("webhook");

/** Relays to linked peers after the response. Skipped outside a request scope. */
function relayAfterResponse(event: GitEvent, raw: { body: string; signature: string }): void {
  if (!event.deliveryId) return;
  const relay = toRelayEvent({ ...event, deliveryId: event.deliveryId }, raw);
  try {
    after(async () => {
      const [{ fanOutRelay }, orgIds] = await Promise.all([
        import("@/lib/mesh/webhook-relay-send"),
        event.installationId !== null ? orgsForInstallation(event.installationId).catch(() => []) : Promise.resolve([]),
      ]);
      await fanOutRelay(relay, orgIds);
    });
  } catch (err) {
    log.warn("Couldn't schedule the webhook relay:", err);
  }
}

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
    const eventName = request.headers.get("x-github-event");
    const signature = request.headers.get("x-hub-signature-256");
    const deliveryId = request.headers.get("x-github-delivery");

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
    if (!verifyGithubSignature(body, signature, secret)) {
      log.error("Invalid signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    if (eventName !== "push" && eventName !== "pull_request") {
      return NextResponse.json({ ok: true, skipped: eventName });
    }

    const event = eventFromGithub(eventName, JSON.parse(body), deliveryId);
    if (!event) {
      return NextResponse.json({ ok: true, skipped: eventName === "push" ? "missing repo or branch" : "missing PR data" });
    }

    // The same delivery can also arrive relayed by a linked instance.
    if (!(await claimDelivery(deliveryId))) {
      log.info(`Delivery ${deliveryId} already handled`);
      return NextResponse.json({ ok: true, skipped: "duplicate delivery" });
    }

    relayAfterResponse(event, { body, signature });

    if (event.kind === "pull_request") {
      return handlePullRequestEvent(event, {
        trigger: "webhook",
        waitForDeploys: true,
        resolveOrgs: async () => {
          const orgIds = event.installationId !== null ? await orgsForInstallation(event.installationId) : [];
          return orgIds.length > 0 ? { orgIds } : { skipped: "installation not linked" };
        },
      });
    }

    return handlePushEvent(event, {
      trigger: "webhook",
      waitForDeploys: true,
      resolveOrgs: async () => {
        // Only orgs the delivering installation is linked to.
        if (event.installationId === null) return { skipped: "no installation" };
        const orgIds = await orgsForInstallation(event.installationId);
        if (orgIds.length === 0) {
          log.info(`Installation ${event.installationId} isn't linked to any organization`);
          return { skipped: "installation not linked" };
        }
        return { orgIds };
      },
    });
  } catch (error) {
    log.error("Error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

export const POST = withRateLimit(handler, { tier: "public", key: "webhook" });
