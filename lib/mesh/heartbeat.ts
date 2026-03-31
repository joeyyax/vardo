import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";
import { meshFetch } from "./client";
import { toCidr } from "./ip-allocator";

const log = logger.child("mesh-heartbeat");

// WireGuard Curve25519 public key — 32 bytes base64-encoded = 44 chars ending in =
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
// Bare IPv4 or IPv4 CIDR (e.g. 10.99.0.2 or 10.99.0.2/32)
const IP_OR_CIDR_RE = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/;

type PeerManifestEntry = {
  id: string;
  instanceId: string;
  name: string;
  type: "persistent" | "dev";
  status: "online" | "offline" | "unreachable";
  internalIp: string;
  allowedIps: string;
  publicKey: string;
  endpoint: string | null;
  lastSeenAt: string | null;
};

type HeartbeatResponse = {
  ok: boolean;
  instance: { id: string; name: string; internalIp: string };
  peers: PeerManifestEntry[];
};

/**
 * Send a heartbeat to a peer and update the peer's status locally on success.
 *
 * When this instance pings a peer and gets a 200, it marks the peer online in
 * the local DB. The peer's handler does the same for this instance when it
 * receives the request — that's the bidirectional liveness tracking.
 *
 * If the responding peer is a hub, it includes a full peer manifest in the
 * response. We upsert those as "visible" peers so the Instances page shows
 * all mesh members, not just direct connections.
 *
 * Returns true if the peer responded with ok, false if it was unreachable.
 */
export async function sendHeartbeatToPeer(peerId: string): Promise<boolean> {
  let ok = false;
  let body: HeartbeatResponse | null = null;

  try {
    const res = await meshFetch(peerId, "/api/v1/mesh/heartbeat", {
      method: "POST",
    });

    ok = res.ok;
    if (ok) {
      try {
        body = await res.json();
      } catch {
        // Non-fatal — status update still proceeds
      }
    }
  } catch {
    ok = false;
  }

  await db
    .update(meshPeers)
    .set({
      status: ok ? "online" : "offline",
      ...(ok ? { lastSeenAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(meshPeers.id, peerId));

  // If the hub returned a peer manifest, sync visible peers into our local DB.
  if (ok && body?.peers && body.peers.length > 0 && body.instance?.id) {
    try {
      await syncVisiblePeers(body.peers, body.instance.id);
    } catch (err) {
      log.warn(`Failed to sync visible peers from hub: ${err}`);
    }
  }

  return ok;
}

/**
 * Upsert peers received from a hub's heartbeat response into the local DB as
 * "visible" entries. Visible peers are read-only — we know they exist in the
 * mesh but have no direct WireGuard tunnel to them.
 *
 * Rules:
 * - Validate hub-provided fields before touching the DB.
 * - Use a local nanoid() for the primary key — never adopt the hub's ID.
 * - Single atomic INSERT … ON CONFLICT DO UPDATE on instanceId — safe under
 *   concurrent heartbeats from multiple hubs with overlapping manifests.
 * - On conflict: update name/status/lastSeenAt only for visible peers.
 *   Direct peers keep all existing values untouched.
 * - Pre-delete stale visible rows whose publicKey or internalIp would collide
 *   with incoming data on a different instanceId (key rotation / reassignment).
 * - Prune visible peers sourced from this hub that are no longer in the manifest.
 *   Scoped to this hub only so we don't clobber entries provided by other hubs.
 * - All mutations run inside a single transaction to prevent races between
 *   concurrent heartbeat timers.
 */
async function syncVisiblePeers(
  peers: PeerManifestEntry[],
  hubInstanceId: string
): Promise<void> {
  if (peers.length === 0) return;

  // Validate hub-provided fields before inserting — reject obviously malformed
  // entries to limit blast radius if a hub is misconfigured or compromised.
  const valid = peers.filter((p) => {
    if (!WG_KEY_RE.test(p.publicKey)) {
      log.warn(
        `syncVisiblePeers: skipping peer ${p.instanceId} — invalid publicKey`
      );
      return false;
    }
    if (!IP_OR_CIDR_RE.test(p.internalIp)) {
      log.warn(
        `syncVisiblePeers: skipping peer ${p.instanceId} — invalid internalIp`
      );
      return false;
    }
    if (p.allowedIps && !IP_OR_CIDR_RE.test(p.allowedIps)) {
      log.warn(
        `syncVisiblePeers: skipping peer ${p.instanceId} — invalid allowedIps`
      );
      return false;
    }
    return true;
  });

  if (valid.length === 0) return;

  const now = new Date();
  const instanceIds = valid.map((p) => p.instanceId);
  const publicKeys = valid.map((p) => p.publicKey);
  const internalIps = valid.map((p) => p.internalIp);

  await db.transaction(async (tx) => {
    // Remove stale visible rows whose publicKey or internalIp would collide
    // with an incoming peer on a *different* instanceId (e.g. key rotation or
    // IP reassignment on the hub). Without this, the batch upsert below would
    // throw a unique-constraint violation that the ON CONFLICT clause doesn't
    // cover (it only targets instanceId).
    await tx
      .delete(meshPeers)
      .where(
        and(
          eq(meshPeers.connectionType, "visible"),
          notInArray(meshPeers.instanceId, instanceIds),
          inArray(meshPeers.publicKey, publicKeys)
        )
      );

    await tx
      .delete(meshPeers)
      .where(
        and(
          eq(meshPeers.connectionType, "visible"),
          notInArray(meshPeers.instanceId, instanceIds),
          inArray(meshPeers.internalIp, internalIps)
        )
      );

    // Single atomic upsert — no read-then-write race under concurrent heartbeats.
    // On conflict on instanceId:
    //   direct peers  → all CASE branches fall through to existing values (no-op)
    //   visible peers → name, status, sourceHubInstanceId, lastSeenAt, updatedAt refreshed
    await tx
      .insert(meshPeers)
      .values(
        valid.map((p) => ({
          id: nanoid(),
          instanceId: p.instanceId,
          name: p.name,
          type: p.type,
          status: p.status,
          internalIp: p.internalIp,
          allowedIps: p.allowedIps ?? toCidr(p.internalIp),
          publicKey: p.publicKey,
          endpoint: p.endpoint ?? null,
          connectionType: "visible" as const,
          sourceHubInstanceId: hubInstanceId,
          lastSeenAt: p.lastSeenAt ? new Date(p.lastSeenAt) : null,
          createdAt: now,
          updatedAt: now,
        }))
      )
      .onConflictDoUpdate({
        target: meshPeers.instanceId,
        set: {
          name: sql`CASE WHEN ${meshPeers.connectionType} = 'visible' THEN EXCLUDED.name ELSE ${meshPeers.name} END`,
          status: sql`CASE WHEN ${meshPeers.connectionType} = 'visible' THEN EXCLUDED.status ELSE ${meshPeers.status} END`,
          sourceHubInstanceId: sql`CASE WHEN ${meshPeers.connectionType} = 'visible' THEN EXCLUDED.source_hub_instance_id ELSE ${meshPeers.sourceHubInstanceId} END`,
          lastSeenAt: sql`CASE WHEN ${meshPeers.connectionType} = 'visible' THEN EXCLUDED.last_seen_at ELSE ${meshPeers.lastSeenAt} END`,
          updatedAt: sql`CASE WHEN ${meshPeers.connectionType} = 'visible' THEN EXCLUDED.updated_at ELSE ${meshPeers.updatedAt} END`,
        },
      });

    // Prune visible peers sourced from this hub that are no longer in the
    // manifest. Scoped to this hub's entries only — other hubs' visible peers
    // are untouched, which prevents heartbeats from one hub silently removing
    // peers registered through another hub.
    await tx
      .delete(meshPeers)
      .where(
        and(
          eq(meshPeers.connectionType, "visible"),
          eq(meshPeers.sourceHubInstanceId, hubInstanceId),
          notInArray(meshPeers.instanceId, instanceIds)
        )
      );
  });
}
