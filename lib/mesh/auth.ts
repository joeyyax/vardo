import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/** Generate a mesh peer token. Store the hash; give the raw token to the peer. */
export function generateMeshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** Hash a raw mesh token for comparison. */
export function hashMeshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** How long an unseen dev peer's token stays valid. */
export const DEV_PEER_MAX_IDLE_MS =
  parseInt(process.env.VARDO_MESH_DEV_PEER_MAX_IDLE_DAYS || "30", 10) * 86_400_000;

/** A dev peer that has not been seen inside the idle window is expired. */
export function isPeerTokenExpired(
  peer: { type: string; lastSeenAt: Date | null; createdAt: Date },
  now: Date = new Date(),
): boolean {
  if (peer.type !== "dev") return false;
  const lastActive = peer.lastSeenAt ?? peer.createdAt;
  return now.getTime() - lastActive.getTime() > DEV_PEER_MAX_IDLE_MS;
}

/**
 * Authenticate a mesh peer request via Bearer token. Throws on failure.
 * Rejects peers with no tunnel and dev peers idle past the expiry window.
 */
export async function requireMeshPeer(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }

  const raw = authHeader.slice(7).trim();
  if (!raw) {
    throw new Error("Unauthorized");
  }

  const tokenHash = hashMeshToken(raw);

  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.tokenHash, tokenHash),
  });

  if (!peer) {
    throw new Error("Unauthorized");
  }

  // Visible peers are hub-reported entries, not paired instances.
  if (peer.connectionType !== "direct") {
    throw new Error("Unauthorized");
  }

  if (isPeerTokenExpired(peer)) {
    throw new Error("Unauthorized");
  }

  return peer;
}

/** The org a peer is bound to. Promote, clone and pull act only inside it. */
export function peerOrganizationId(peer: { organizationId: string | null }): string {
  if (!peer.organizationId) throw new Error("Forbidden");
  return peer.organizationId;
}
