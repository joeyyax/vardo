// Receiving side of the webhook relay: opt-in, dedupe, then the same matching a direct webhook runs. Never relays on.

import { NextResponse } from "next/server";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { getGitHubAppConfig, getInstanceDisplayName } from "@/lib/system-settings";
import { logger } from "@/lib/logger";
import { claimDelivery } from "@/lib/git-integration/delivery-dedupe";
import {
  eventFromGithub,
  eventFromRelay,
  relayEventSchema,
  sameDeployTarget,
  verifyGithubSignature,
  type GitEvent,
} from "@/lib/git-integration/webhook-event";
import { handlePullRequestEvent, handlePushEvent, type EventScope, type MatchedApp } from "@/lib/git-integration/webhook-handler";

const log = logger.child("webhook-relay");

export type RelayingPeer = { id: string; name: string; instanceId: string; organizationId: string | null; acceptWebhookRelay: boolean };

async function recordReceived(peerId: string, status: string): Promise<void> {
  await db
    .update(meshPeers)
    .set({ lastRelayReceivedAt: new Date(), lastRelayReceivedStatus: status.slice(0, 500) })
    .where(eq(meshPeers.id, peerId))
    .catch(() => {});
}

/** The peer's bound org, else every org here. */
async function relayOrgs(peer: RelayingPeer): Promise<{ orgIds: string[] } | { skipped: string }> {
  if (peer.organizationId) return { orgIds: [peer.organizationId] };
  const orgs = await db.query.organizations.findMany({ columns: { id: true } });
  return orgs.length > 0 ? { orgIds: orgs.map((o) => o.id) } : { skipped: "no organizations" };
}

/** GitHub's own signature, when the relay carries the body and this instance holds the same webhook secret. */
async function githubCheck(
  relay: { github?: { event: string; body: string; signature: string } },
  event: GitEvent,
): Promise<"verified" | "unverified" | "mismatch"> {
  if (!relay.github) return "unverified";
  const secret = (await getGitHubAppConfig().catch(() => null))?.webhookSecret;
  if (!secret || !verifyGithubSignature(relay.github.body, relay.github.signature, secret)) return "unverified";
  let payload: unknown;
  try {
    payload = JSON.parse(relay.github.body);
  } catch {
    return "mismatch";
  }
  const fromGithub = eventFromGithub(relay.github.event, payload, event.deliveryId);
  return fromGithub && sameDeployTarget(fromGithub, event) ? "verified" : "mismatch";
}

/** Handles a relayed event from `peer`. The caller has checked the mesh signature and nonce. */
export async function receiveRelay(peer: RelayingPeer, body: unknown): Promise<NextResponse> {
  if (!peer.acceptWebhookRelay) {
    const here = (await getInstanceDisplayName()) ?? "this instance";
    await recordReceived(peer.id, "refused: relays from this peer are off");
    return NextResponse.json(
      { error: `${here} doesn't accept relayed webhooks from ${peer.name}. An admin there can turn it on.` },
      { status: 403 },
    );
  }

  const parsed = relayEventSchema.safeParse(body);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "Invalid relay event";
    await recordReceived(peer.id, `refused: ${reason}`);
    return NextResponse.json({ error: reason }, { status: 400 });
  }
  const relay = parsed.data;
  const event = eventFromRelay(relay);

  const github = await githubCheck(relay, event);
  if (github === "mismatch") {
    await recordReceived(peer.id, "refused: doesn't match GitHub's signed body");
    return NextResponse.json({ error: "Relay doesn't match GitHub's signed body" }, { status: 400 });
  }

  if (!(await claimDelivery(relay.deliveryId))) {
    await recordReceived(peer.id, "duplicate delivery");
    return NextResponse.json({ ok: true, skipped: "duplicate delivery" });
  }

  let matched: MatchedApp[] = [];
  const scope: EventScope = {
    trigger: "relay",
    waitForDeploys: false,
    resolveOrgs: () => relayOrgs(peer),
    onMatched: (apps) => {
      matched = apps;
    },
  };

  const res = event.kind === "push" ? await handlePushEvent(event, scope) : await handlePullRequestEvent(event, scope);

  const result = (await res.clone().json().catch(() => ({}))) as { skipped?: string; accepted?: unknown };
  const summary =
    matched.length > 0
      ? `deploying ${matched.map((a) => a.name).join(", ")}`
      : typeof result.skipped === "string"
        ? result.skipped
        : typeof result.accepted === "string"
          ? result.accepted
          : "handled";
  await recordReceived(peer.id, github === "verified" ? `${summary} (GitHub signature verified)` : summary);

  for (const app of matched) {
    await recordActivity({
      organizationId: app.organizationId,
      action: "mesh.webhook_relay_received",
      appId: app.id,
      metadata: {
        trigger: peer.name,
        peerId: peer.id,
        originInstanceId: peer.instanceId,
        repo: event.repoFullName,
        branch: event.branch,
        sha: event.headSha,
        deliveryId: relay.deliveryId,
        githubVerified: github === "verified",
      },
    }).catch(() => {});
  }

  log.info(`Relay ${relay.deliveryId} from ${peer.name}: ${summary}`);
  return res;
}

/** How many linked instances may relay webhooks into `orgId`. A count only; peers stay out of org routes. */
export async function relaySourceCount(orgId: string): Promise<number> {
  const rows = await db.query.meshPeers.findMany({
    where: and(
      eq(meshPeers.connectionType, "direct"),
      eq(meshPeers.acceptWebhookRelay, true),
      or(isNull(meshPeers.organizationId), eq(meshPeers.organizationId, orgId)),
    ),
    columns: { id: true },
  });
  return rows.length;
}
