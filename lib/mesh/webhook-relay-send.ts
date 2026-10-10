// Sending side of the webhook relay: one signed POST per linked peer that accepts relays from here.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { logger } from "@/lib/logger";
import { WEBHOOK_RELAY_PATH, type RelayEvent } from "@/lib/git-integration/webhook-event";
import { meshSignedPost } from "./client";

const log = logger.child("webhook-relay");

/** Per-peer budget. A slow or offline peer can't hold up the rest; it catches up by polling. */
export const RELAY_TIMEOUT_MS = 10_000;
export const RELAY_PROBE_MS = 2_000;

export type RelayOutcome = { peerId: string; name: string; ok: boolean; status: string };

/** Directly linked peers whose last heartbeat said they accept our relays. Hub-only peers need a direct link. */
async function relayTargets(): Promise<{ id: string; name: string }[]> {
  return db.query.meshPeers.findMany({
    where: and(eq(meshPeers.connectionType, "direct"), eq(meshPeers.peerAcceptsWebhookRelay, true)),
    columns: { id: true, name: true },
  });
}

function describe(data: unknown): string {
  const d = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  if (Array.isArray(d.accepted)) return `deploying ${d.accepted.length}`;
  if (typeof d.skipped === "string") return d.skipped;
  return "delivered";
}

/** Relays one event to every accepting peer at once and records each result. Never throws. */
export async function fanOutRelay(event: RelayEvent, activityOrgIds: string[] = []): Promise<RelayOutcome[]> {
  let peers: { id: string; name: string }[];
  try {
    peers = await relayTargets();
  } catch (err) {
    log.error("Couldn't list relay targets:", err);
    return [];
  }
  if (peers.length === 0) return [];

  const outcomes = await Promise.all(
    peers.map(async (peer): Promise<RelayOutcome> => {
      try {
        const { data } = await meshSignedPost(peer.id, WEBHOOK_RELAY_PATH, event, {
          timeoutMs: RELAY_TIMEOUT_MS,
          probeMs: RELAY_PROBE_MS,
        });
        return { peerId: peer.id, name: peer.name, ok: true, status: describe(data) };
      } catch (err) {
        return { peerId: peer.id, name: peer.name, ok: false, status: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const now = new Date();
  await Promise.all(
    outcomes.map(async (o) => {
      if (!o.ok) log.warn(`Relay of ${event.deliveryId} to ${o.name} failed: ${o.status}`);
      await db
        .update(meshPeers)
        .set({ lastRelaySentAt: now, lastRelaySentStatus: o.ok ? o.status : `failed: ${o.status}`.slice(0, 500) })
        .where(eq(meshPeers.id, o.peerId))
        .catch(() => {});
      for (const organizationId of activityOrgIds) {
        await recordActivity({
          organizationId,
          action: o.ok ? "mesh.webhook_relayed" : "mesh.webhook_relay_failed",
          metadata: {
            trigger: o.name,
            peerId: o.peerId,
            repo: event.repoFullName,
            branch: event.branch,
            deliveryId: event.deliveryId,
            ...(o.ok ? { result: o.status } : { error: o.status }),
          },
        }).catch(() => {});
      }
    }),
  );

  return outcomes;
}
