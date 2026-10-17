// Linked instances as build targets: the peer's mesh address, its exchanged host key and this instance's client key.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { MESH_SSH_PORT, MESH_SSH_USER } from "./constants";
import { ownMeshAddress } from "./heartbeat";
import { meshClientKey, normalizeEd25519 } from "./ssh-endpoint";

export type MeshBuildPeer = {
  peerId: string;
  name: string;
  host: string;
  port: number;
  user: string;
  privateKey: string;
  /** known_hosts line from the key exchange; null while the peer can't take builds. */
  hostKey: string | null;
  /** Why it can't take builds yet. */
  waiting: string | null;
  /** The peer says it runs builds from here. */
  accepts: boolean;
};

/** known_hosts line for a host key at `host:port`. */
export function knownHostsLine(host: string, port: number, key: string): string {
  return `${port === 22 ? host : `[${host}]:${port}`} ${key}`;
}

/** Direct peers with a mesh address, ready or with the reason they aren't. */
export async function meshBuildPeers(): Promise<MeshBuildPeer[]> {
  const rows = await db.query.meshPeers.findMany({
    where: eq(meshPeers.connectionType, "direct"),
    columns: { id: true, name: true, internalIp: true, peerAcceptsBuilds: true, peerSshHostKey: true, peerSshPort: true },
  });
  const linked = rows.filter((r) => ownMeshAddress(r.internalIp));
  const client = linked.some((r) => r.peerAcceptsBuilds) ? await meshClientKey().catch(() => null) : null;
  const fallbackPort = Number(MESH_SSH_PORT) || 22;
  return linked.map((r) => {
    const host = ownMeshAddress(r.internalIp)!;
    const port = r.peerSshPort ?? fallbackPort;
    const key = normalizeEd25519(r.peerSshHostKey);
    const waiting = !r.peerAcceptsBuilds
      ? `${r.name} doesn't accept builds from here`
      : !key
        ? `${r.name} hasn't sent its mesh SSH host key yet`
        : !client
          ? "this instance has no mesh SSH key yet"
          : null;
    return {
      peerId: r.id,
      name: r.name,
      host,
      port,
      user: MESH_SSH_USER,
      privateKey: client?.privateKey ?? "",
      hostKey: waiting === null ? knownHostsLine(host, port, key!) : null,
      waiting,
      accepts: r.peerAcceptsBuilds,
    };
  });
}
