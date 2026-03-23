import { createHash, randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * Generate a mesh peer token (used for service-to-service auth over WireGuard).
 * Returns { raw, hash } — store the hash, give the raw token to the peer.
 */
export function generateMeshToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

/** Hash a raw mesh token for comparison. */
export function hashMeshToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Authenticate a mesh peer request via Bearer token.
 * Returns the peer record if valid, throws otherwise.
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

  return peer;
}
