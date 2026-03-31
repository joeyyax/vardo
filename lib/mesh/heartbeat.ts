import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { meshFetch } from "./client";
import { toCidr } from "./ip-allocator";

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
  if (ok && body?.peers && body.peers.length > 0) {
    await syncVisiblePeers(body.peers);
  }

  return ok;
}

/**
 * Upsert peers received from a hub's heartbeat response into the local DB as
 * "visible" entries. Visible peers are read-only — we know they exist in the
 * mesh but have no direct WireGuard tunnel to them.
 *
 * Rules:
 * - Insert new peers that we haven't seen before.
 * - Update name/status/lastSeenAt for existing visible peers.
 * - Never downgrade a "direct" peer to "visible".
 */
async function syncVisiblePeers(peers: PeerManifestEntry[]): Promise<void> {
  if (peers.length === 0) return;

  const instanceIds = peers.map((p) => p.instanceId);
  const existing = await db.query.meshPeers.findMany({
    where: inArray(meshPeers.instanceId, instanceIds),
    columns: { instanceId: true, connectionType: true },
  });

  const existingByInstanceId = new Map(
    existing.map((p) => [p.instanceId, p.connectionType])
  );

  const now = new Date();

  for (const p of peers) {
    const existingType = existingByInstanceId.get(p.instanceId);

    if (!existingType) {
      // New peer — insert as visible
      await db.insert(meshPeers).values({
        id: p.id,
        instanceId: p.instanceId,
        name: p.name,
        type: p.type,
        status: p.status,
        internalIp: p.internalIp,
        allowedIps: p.allowedIps ?? toCidr(p.internalIp),
        publicKey: p.publicKey,
        endpoint: p.endpoint ?? null,
        connectionType: "visible",
        lastSeenAt: p.lastSeenAt ? new Date(p.lastSeenAt) : null,
        createdAt: now,
        updatedAt: now,
      });
    } else if (existingType === "visible") {
      // Refresh name, status and last-seen for visible peers
      await db
        .update(meshPeers)
        .set({
          name: p.name,
          status: p.status,
          lastSeenAt: p.lastSeenAt ? new Date(p.lastSeenAt) : null,
          updatedAt: now,
        })
        .where(eq(meshPeers.instanceId, p.instanceId));
    }
    // Direct connections keep their own status — don't touch them.
  }
}
