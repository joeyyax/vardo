// Mesh key exchange: each side sends whether it runs the other's builds, its builder client key and its builder offer, over a signed peer call.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { MeshClientError, meshSignedPost } from "./client";
import { FORGET_BUILDER, localBuilderPayload, peerBuilderColumns, type BuilderPayload, type BuilderPeer, type PeerBuilderColumns } from "./builder-exchange";

const log = logger.child("mesh-keys");

/** The path older peers call too. */
export const KEYS_PATH = "/api/v1/mesh/ssh-keys";

/** The key route's answer to a caller it has no link for. */
export const UNLINKED_STATUS = 410;

/** Resent this often even when nothing changed. */
const RESEND_MS = 10 * 60_000;

export type KeysPayload = BuilderPayload & {
  sshKey: null;
  sshHostKey: null;
  sshPort: null;
  acceptsBuilds: boolean;
};

export type PeerKeyColumns = PeerBuilderColumns & Partial<{ peerAcceptsBuilds: boolean }>;

/** What this side sends a peer: whether it runs that peer's builds per the link, and its builder when it does. */
export async function localKeys(peer: BuilderPeer): Promise<KeysPayload> {
  // Nulls clear the mesh SSH keys an older peer stored for this instance.
  return { sshKey: null, sshHostKey: null, sshPort: null, acceptsBuilds: peer.acceptBuilds, ...(await localBuilderPayload(peer)) };
}

/** Columns to store from what a peer sent. A malformed field is left as it is; null clears it. */
export function peerKeyColumns(sent: unknown): PeerKeyColumns {
  const s = sent && typeof sent === "object" ? (sent as Record<string, unknown>) : {};
  const out: PeerKeyColumns = {};
  if (typeof s.acceptsBuilds === "boolean") out.peerAcceptsBuilds = s.acceptsBuilds;
  return { ...out, ...peerBuilderColumns(s) };
}

/** Stores what a peer sent. */
export async function storePeerKeys(peer: Pick<BuilderPeer, "id">, sent: unknown): Promise<PeerKeyColumns> {
  const columns = peerKeyColumns(sent);
  if (Object.keys(columns).length === 0) return columns;
  await db.update(meshPeers).set({ ...columns, updatedAt: new Date() }).where(eq(meshPeers.id, peer.id));
  return columns;
}

const globalForExchange = globalThis as unknown as { __vardo_key_exchange?: Map<string, { digest: string; at: number }> };
const sent = (globalForExchange.__vardo_key_exchange ??= new Map());

/** Test hook. */
export function resetKeyExchange(): void {
  sent.clear();
}

export type ExchangeResult = "sent" | "skipped" | "unsupported" | "forgotten" | "failed";

/** Trades keys with a direct peer. Skipped when nothing changed lately unless `force`. */
export async function exchangeKeys(peerId: string, { force = false }: { force?: boolean } = {}): Promise<ExchangeResult> {
  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.id, peerId),
    columns: { id: true, name: true, connectionType: true, acceptBuilds: true, peerBuilderKey: true, builderCert: true },
  });
  if (!peer || peer.connectionType !== "direct") return "skipped";

  const payload = await localKeys(peer);
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const last = sent.get(peerId);
  if (!force && peer.peerBuilderKey !== null && last?.digest === digest && Date.now() - last.at < RESEND_MS) return "skipped";

  try {
    const { data } = await meshSignedPost<unknown>(peerId, KEYS_PATH, payload, { timeoutMs: 15_000 });
    sent.set(peerId, { digest, at: Date.now() });
    const stored = await storePeerKeys(peer, data);
    // A new key from the peer gets its certificate on the next exchange rather than in ten minutes.
    if (stored.peerBuilderKey !== undefined && stored.peerBuilderKey !== peer.peerBuilderKey) sent.delete(peerId);
    return "sent";
  } catch (err) {
    if (err instanceof MeshClientError && err.statusCode === 404) {
      sent.set(peerId, { digest, at: Date.now() });
      return "unsupported";
    }
    // The peer no longer knows our token: the link is gone on its side, so its builder access ends here.
    if (err instanceof MeshClientError && err.statusCode === UNLINKED_STATUS) {
      await storePeerKeys(peer, { acceptsBuilds: false, ...FORGET_BUILDER });
      sent.delete(peerId);
      return "forgotten";
    }
    log.debug(`Mesh key exchange with ${peer.name} failed: ${err instanceof Error ? err.message : err}`);
    return "failed";
  }
}
