// Linked instances as build targets: the peer's isolated builder when it offers one, else mesh SSH to its Docker.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { MESH_BUILDER_SERVER_NAME, MESH_SSH_PORT, MESH_SSH_USER } from "./constants";
import { ownMeshAddress } from "./heartbeat";
import { meshClientKey, normalizeEd25519 } from "./ssh-endpoint";
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
  port: number;
  user: string;
  privateKey: string;
  /** known_hosts line from the key exchange; null while the peer can't take builds over SSH. */
  hostKey: string | null;
  /** The peer's isolated builder; null for an older peer, which builds over SSH. */
  builder: MeshBuilderAccess | null;
  /** Why it can't take builds yet. */
  waiting: string | null;
  /** The peer says it runs builds from here. */
  accepts: boolean;
};

/** known_hosts line for a host key at `host:port`. */
export function knownHostsLine(host: string, port: number, key: string): string {
  return `${port === 22 ? host : `[${host}]:${port}`} ${key}`;
}

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
    columns: {
      id: true, name: true, internalIp: true, peerAcceptsBuilds: true, peerSshHostKey: true, peerSshPort: true,
      peerBuilderPort: true, peerBuilderCa: true, peerBuilderCert: true,
    },
  });
  const linked = rows.filter((r) => ownMeshAddress(r.internalIp));
  const accepting = linked.filter((r) => r.peerAcceptsBuilds);
  const builderKey = accepting.some((r) => r.peerBuilderCert) ? await builderClientKey().catch(() => null) : null;
  const sshKey = accepting.some((r) => !r.peerBuilderCert) ? await meshClientKey().catch(() => null) : null;
  const fallbackPort = Number(MESH_SSH_PORT) || 22;
  return linked.map((r) => {
    const host = ownMeshAddress(r.internalIp)!;
    const port = r.peerSshPort ?? fallbackPort;
    const builder = r.peerAcceptsBuilds ? builderAccess(host, r, builderKey) : null;
    const key = normalizeEd25519(r.peerSshHostKey);
    const waiting = !r.peerAcceptsBuilds
      ? `${r.name} doesn't accept builds from here`
      : builder
        ? null
        : r.peerBuilderCert
          ? `${r.name}'s builder certificate for this instance has expired or doesn't match its key`
          : !key
            ? `${r.name} hasn't sent its mesh SSH host key yet`
            : !sshKey
              ? "this instance has no mesh SSH key yet"
              : null;
    return {
      peerId: r.id,
      name: r.name,
      host,
      port,
      user: MESH_SSH_USER,
      privateKey: builder ? "" : sshKey?.privateKey ?? "",
      hostKey: !builder && waiting === null ? knownHostsLine(host, port, key!) : null,
      builder,
      waiting,
      accepts: r.peerAcceptsBuilds,
    };
  });
}
