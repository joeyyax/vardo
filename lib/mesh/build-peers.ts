// Linked instances as build targets: each builds in the peer's isolated builder, or waits until it offers one.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { MESH_BUILDER_PORT, MESH_BUILDER_SERVER_NAME } from "./constants";
import { ownMeshAddress } from "./heartbeat";
import { builderClientKey } from "./builder-tls";
import { certInfo, issuedBy, normalizeEd25519Spki } from "./x509";

/** How to reach a peer's isolated builder: BuildKit over TLS on its tunnel address, with the client certificate it issued. */
export type MeshBuilderAccess = {
  host: string;
  port: number;
  serverName: string;
  ca: string;
  cert: string;
  key: string;
};

export type MeshBuildPeer = {
  peerId: string;
  name: string;
  host: string;
  /** The builder's port, or the default one until the peer offers it. */
  port: number;
  /** The peer's isolated builder; null until it offers one. */
  builder: MeshBuilderAccess | null;
  /** Why it can't take builds yet. */
  waiting: string | null;
  /** The peer says it runs builds from here. */
  accepts: boolean;
};

type BuilderColumns = { peerBuilderPort: number | null; peerBuilderCa: string | null; peerBuilderCert: string | null };

/** The builder access a peer's columns give, or null when its certificate is missing, expired or for another key. */
export function builderAccess(host: string, r: BuilderColumns, client: { privateKey: string; publicKey: string } | null, now = new Date()): MeshBuilderAccess | null {
  if (!client || !r.peerBuilderPort || !r.peerBuilderCa || !r.peerBuilderCert) return null;
  if (!issuedBy(r.peerBuilderCert, r.peerBuilderCa, now)) return null;
  if (normalizeEd25519Spki(certInfo(r.peerBuilderCert)?.publicKey) !== normalizeEd25519Spki(client.publicKey)) return null;
  return { host, port: r.peerBuilderPort, serverName: MESH_BUILDER_SERVER_NAME, ca: r.peerBuilderCa, cert: r.peerBuilderCert, key: client.privateKey };
}

/** Direct peers with a mesh address, ready or with the reason they aren't. */
export async function meshBuildPeers(): Promise<MeshBuildPeer[]> {
  const rows = await db.query.meshPeers.findMany({
    where: eq(meshPeers.connectionType, "direct"),
    columns: { id: true, name: true, internalIp: true, peerAcceptsBuilds: true, peerBuilderPort: true, peerBuilderCa: true, peerBuilderCert: true },
  });
  const linked = rows.filter((r) => ownMeshAddress(r.internalIp));
  const builderKey = linked.some((r) => r.peerAcceptsBuilds && r.peerBuilderCert) ? await builderClientKey().catch(() => null) : null;
  return linked.map((r) => {
    const host = ownMeshAddress(r.internalIp)!;
    const builder = r.peerAcceptsBuilds ? builderAccess(host, r, builderKey) : null;
    const waiting = !r.peerAcceptsBuilds
      ? `${r.name} doesn't accept builds from here`
      : builder
        ? null
        : !r.peerBuilderCert
          ? `${r.name} hasn't offered its isolated builder yet`
          : !builderKey
            ? "this instance has no builder client key yet"
            : `${r.name}'s builder certificate for this instance has expired or doesn't match its key`;
    return {
      peerId: r.id,
      name: r.name,
      host,
      port: r.peerBuilderPort ?? (Number(MESH_BUILDER_PORT) || 1234),
      builder,
      waiting,
      accepts: r.peerAcceptsBuilds,
    };
  });
}
