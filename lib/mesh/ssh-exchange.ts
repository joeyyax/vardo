// Mesh SSH key exchange: each side sends its client key, endpoint host key and port over a signed peer call.

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { MeshClientError, meshSignedPost } from "./client";
import { MESH_SSH_PORT } from "./constants";
import { meshClientKey, meshSshHostKey, normalizeEd25519, syncAuthorizedKeys } from "./ssh-endpoint";

const log = logger.child("mesh-ssh");

export const SSH_KEYS_PATH = "/api/v1/mesh/ssh-keys";

/** The key route's answer to a caller it has no link for. */
export const UNLINKED_STATUS = 410;

/** Resent this often even when nothing changed. */
const RESEND_MS = 10 * 60_000;

export type SshKeysPayload = {
  sshKey: string | null;
  sshHostKey: string | null;
  sshPort: number | null;
  acceptsBuilds: boolean;
};

export type PeerSshColumns = Partial<{
  peerSshKey: string | null;
  peerSshHostKey: string | null;
  peerSshPort: number | null;
  peerAcceptsBuilds: boolean;
}>;

/** What this side sends a peer: keys always, whether it runs that peer's builds per the link. */
export async function localSshKeys(peer: { acceptBuilds: boolean }): Promise<SshKeysPayload> {
  const [client, hostKey] = await Promise.all([meshClientKey().catch(() => null), meshSshHostKey()]);
  const port = Number(MESH_SSH_PORT);
  return {
    sshKey: client?.publicKey ?? null,
    sshHostKey: hostKey,
    sshPort: hostKey && Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    acceptsBuilds: peer.acceptBuilds,
  };
}

/** Columns to store from what a peer sent. A malformed field is left as it is; null clears it. */
export function peerSshColumns(sent: unknown): PeerSshColumns {
  const s = sent && typeof sent === "object" ? (sent as Record<string, unknown>) : {};
  const key = (v: unknown) => (v === null ? null : normalizeEd25519(v) ?? undefined);
  const out: PeerSshColumns = {};
  if ("sshKey" in s && key(s.sshKey) !== undefined) out.peerSshKey = key(s.sshKey)!;
  if ("sshHostKey" in s && key(s.sshHostKey) !== undefined) out.peerSshHostKey = key(s.sshHostKey)!;
  if (s.sshPort === null) out.peerSshPort = null;
  else if (Number.isInteger(s.sshPort) && (s.sshPort as number) > 0 && (s.sshPort as number) < 65536) out.peerSshPort = s.sshPort as number;
  if (typeof s.acceptsBuilds === "boolean") out.peerAcceptsBuilds = s.acceptsBuilds;
  return out;
}

type StoredPeer = { id: string; acceptBuilds: boolean; peerSshKey: string | null };

/** Stores what a peer sent; rewrites authorized_keys when its key changed and this side runs its builds. */
export async function storePeerSsh(peer: StoredPeer, sent: unknown): Promise<PeerSshColumns> {
  const columns = peerSshColumns(sent);
  if (Object.keys(columns).length === 0) return columns;
  await db.update(meshPeers).set({ ...columns, updatedAt: new Date() }).where(eq(meshPeers.id, peer.id));
  if (peer.acceptBuilds && columns.peerSshKey !== undefined && columns.peerSshKey !== peer.peerSshKey) {
    await syncAuthorizedKeys().catch((err) => log.warn(`Couldn't update mesh SSH keys: ${err instanceof Error ? err.message : err}`));
  }
  return columns;
}

const globalForExchange = globalThis as unknown as { __vardo_ssh_exchange?: Map<string, { digest: string; at: number }> };
const sent = (globalForExchange.__vardo_ssh_exchange ??= new Map());

/** Test hook. */
export function resetSshExchange(): void {
  sent.clear();
}

export type ExchangeResult = "sent" | "skipped" | "unsupported" | "forgotten" | "failed";

/** Trades keys with a direct peer. Skipped when nothing changed lately unless `force`. */
export async function exchangeSshKeys(peerId: string, { force = false }: { force?: boolean } = {}): Promise<ExchangeResult> {
  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.id, peerId),
    columns: { id: true, name: true, connectionType: true, acceptBuilds: true, peerSshKey: true, peerSshHostKey: true },
  });
  if (!peer || peer.connectionType !== "direct") return "skipped";

  const payload = await localSshKeys(peer);
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const last = sent.get(peerId);
  const known = peer.peerSshKey !== null || peer.peerSshHostKey !== null;
  if (!force && known && last?.digest === digest && Date.now() - last.at < RESEND_MS) return "skipped";

  try {
    const { data } = await meshSignedPost<unknown>(peerId, SSH_KEYS_PATH, payload, { timeoutMs: 15_000 });
    sent.set(peerId, { digest, at: Date.now() });
    await storePeerSsh(peer, data);
    return "sent";
  } catch (err) {
    if (err instanceof MeshClientError && err.statusCode === 404) {
      sent.set(peerId, { digest, at: Date.now() });
      return "unsupported";
    }
    // The peer no longer knows our token: the link is gone on its side, so its key stops working here.
    if (err instanceof MeshClientError && err.statusCode === UNLINKED_STATUS) {
      await storePeerSsh(peer, { sshKey: null, sshHostKey: null, sshPort: null, acceptsBuilds: false });
      sent.delete(peerId);
      return "forgotten";
    }
    log.debug(`Mesh SSH key exchange with ${peer.name} failed: ${err instanceof Error ? err.message : err}`);
    return "failed";
  }
}
