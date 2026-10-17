// The isolated builder's part of the signed key exchange: each side's client key, and certificates for peers it runs builds for.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { MESH_BUILDER_PORT } from "./constants";
import { builderCa, builderClientKey, issueClientCert, meshBuilderRunning, needsReissue } from "./builder-tls";
import { certInfo, issuedBy, normalizeEd25519Spki } from "./x509";

const log = logger.child("mesh-builder");

/** What one side tells the other about its builder. */
export type BuilderOffer = { port: number; ca: string; cert: string };

export type BuilderPayload = {
  /** This side's client key, for the peer's builder to certify. */
  builderKey: string | null;
  /** This side's builder, when it runs the peer's builds there. */
  builder: BuilderOffer | null;
};

export type PeerBuilderColumns = Partial<{
  peerBuilderKey: string | null;
  peerBuilderPort: number | null;
  peerBuilderCa: string | null;
  peerBuilderCert: string | null;
}>;

export type BuilderPeer = { id: string; acceptBuilds: boolean; peerBuilderKey: string | null; builderCert: string | null };

function builderPort(): number | null {
  const port = Number(MESH_BUILDER_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * This side's builder offer for `peer`: only while it accepts the peer's builds, has the peer's key and runs the builder.
 * Issues a fresh certificate when the stored one is missing or past half its life, and forgets it otherwise.
 */
export async function builderOffer(peer: BuilderPeer, { now = new Date(), running = meshBuilderRunning }: { now?: Date; running?: () => Promise<boolean> } = {}): Promise<BuilderOffer | null> {
  const port = builderPort();
  const key = normalizeEd25519Spki(peer.peerBuilderKey);
  if (!peer.acceptBuilds || !key || !port || !(await running())) {
    if (peer.builderCert) {
      await db.update(meshPeers).set({ builderCert: null, updatedAt: new Date() }).where(eq(meshPeers.id, peer.id));
      void import("./builder-forward").then((m) => m.reconcileBuilderForward()).catch(() => {});
    }
    return null;
  }
  const ca = await builderCa();
  let cert = peer.builderCert;
  if (needsReissue(cert, ca.cert, key, now)) {
    cert = issueClientCert(ca, peer.id, key, now);
    await db.update(meshPeers).set({ builderCert: cert, updatedAt: new Date() }).where(eq(meshPeers.id, peer.id));
    log.debug(`Issued a builder certificate for peer ${peer.id}`);
    if (!peer.builderCert) void import("./builder-forward").then((m) => m.reconcileBuilderForward()).catch(() => {});
  }
  return { port, ca: ca.cert, cert: cert! };
}

/** This side's half of the exchange for `peer`. */
export async function localBuilderPayload(peer: BuilderPeer): Promise<BuilderPayload> {
  const [key, builder] = await Promise.all([
    builderClientKey().catch(() => null),
    builderOffer(peer).catch((err) => {
      log.warn(`Couldn't offer the builder to peer ${peer.id}: ${err instanceof Error ? err.message : err}`);
      return null;
    }),
  ]);
  return { builderKey: key?.publicKey ?? null, builder };
}

/** Columns to store from what a peer sent. An older peer sends neither field and its columns stay as they are; null clears. */
export function peerBuilderColumns(sent: unknown): PeerBuilderColumns {
  const s = sent && typeof sent === "object" ? (sent as Record<string, unknown>) : {};
  const out: PeerBuilderColumns = {};
  if (s.builderKey === null) out.peerBuilderKey = null;
  else if ("builderKey" in s && normalizeEd25519Spki(s.builderKey)) out.peerBuilderKey = normalizeEd25519Spki(s.builderKey);
  if (s.builder === null) Object.assign(out, { peerBuilderPort: null, peerBuilderCa: null, peerBuilderCert: null });
  else if (s.builder && typeof s.builder === "object") {
    const b = s.builder as Record<string, unknown>;
    const port = Number(b.port);
    if (Number.isInteger(port) && port > 0 && port < 65536 && typeof b.ca === "string" && typeof b.cert === "string" && certInfo(b.ca) && issuedBy(b.cert, b.ca)) {
      Object.assign(out, { peerBuilderPort: port, peerBuilderCa: b.ca, peerBuilderCert: b.cert });
    }
  }
  return out;
}

/** The columns that forget a peer's builder and key, as when the link is gone. */
export const FORGET_BUILDER = { builderKey: null, builder: null } as const;
