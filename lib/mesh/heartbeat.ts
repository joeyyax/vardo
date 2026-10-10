import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";
import { meshFetch } from "./client";
import { toCidr } from "./ip-allocator";
import { localVardoStatus, parseVardoStatus, vardoStatusColumns } from "@/lib/self-update/peer-status";

const log = logger.child("mesh-heartbeat");

// WireGuard Curve25519 public key: 44 base64 chars ending in =
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
// Bare IPv4 or IPv4 CIDR with octets 0-255
const IP_OR_CIDR_RE =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]\d|\d)){3}(\/\d{1,2})?$/;

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
  instance: { id: string; name: string; internalIp: string; vardo?: unknown };
  peers: PeerManifestEntry[];
};

/**
 * Heartbeat a peer and mark it online locally on success; returns false when unreachable.
 * A hub's response carries its peer manifest, synced in as visible peers.
 */
export async function sendHeartbeatToPeer(peerId: string): Promise<boolean> {
  let ok = false;
  let body: HeartbeatResponse | null = null;

  try {
    const res = await meshFetch(peerId, "/api/v1/mesh/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vardo: localVardoStatus() }),
    });

    ok = res.ok;
    if (ok) {
      try {
        body = await res.json();
      } catch {
        // Non-fatal.
      }
    }
  } catch {
    ok = false;
  }

  await db
    .update(meshPeers)
    .set({
      status: ok ? "online" : "offline",
      ...(ok ? { lastSeenAt: new Date(), ...vardoStatusColumns(parseVardoStatus(body?.instance?.vardo)) } : {}),
      updatedAt: new Date(),
    })
    .where(eq(meshPeers.id, peerId));

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
 * Upsert a hub's peer manifest as read-only "visible" peers in one transaction.
 * Local ids only; direct peers are never modified; pruning is scoped to this hub.
 */
export async function syncVisiblePeers(
  peers: PeerManifestEntry[],
  hubInstanceId: string
): Promise<void> {
  if (peers.length === 0) return;

  // Reject malformed entries from a misconfigured or compromised hub.
  const valid = peers.filter((p) => {
    if (!p.instanceId || p.instanceId.length > 128) {
      log.warn(`syncVisiblePeers: skipping peer — invalid instanceId`);
      return false;
    }
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
    // Drop visible rows whose publicKey or internalIp collides on a different instanceId.
    // ON CONFLICT only covers instanceId, so these would throw.
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

    // On instanceId conflict, direct peers keep their values; visible peers are refreshed.
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
          allowedIps: p.allowedIps || toCidr(p.internalIp),
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

    // Prune this hub's visible peers missing from the manifest. Other hubs' entries stay.
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
