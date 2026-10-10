import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { getInstanceId } from "@/lib/constants";
import { getInstanceConfig } from "@/lib/system-settings";
import { localVardoStatus } from "@/lib/self-update/peer-status";
import { getUpdatePolicy } from "@/lib/self-update/store";

export type PeerRow = typeof meshPeers.$inferSelect;

export type InstanceLabel = { id: string; name: string; local: boolean };

export type InstanceTarget =
  | { kind: "local"; label: InstanceLabel }
  | { kind: "peer"; peer: PeerRow; label: InstanceLabel }
  | { kind: "elsewhere" };

const LOCAL_ALIASES = new Set(["local", "self", "this"]);

async function localIdentity(): Promise<{ id: string; name: string }> {
  const [id, config] = await Promise.all([getInstanceId(), getInstanceConfig()]);
  return { id, name: config.instanceName || config.domain || "local" };
}

/** Resolves an `instance` argument to this instance or a directly linked peer. Without `peers`, anything else is "elsewhere". */
export async function resolveInstance(
  ref: unknown,
  { peers: withPeers = true }: { peers?: boolean } = {}
): Promise<InstanceTarget | { error: string }> {
  const self = await localIdentity();
  const local: InstanceTarget = { kind: "local", label: { ...self, local: true } };
  if (ref === undefined || ref === null || ref === "") return local;
  if (typeof ref !== "string") return { error: "instance must be a string" };

  const wanted = ref.trim().toLowerCase();
  const isLocal = LOCAL_ALIASES.has(wanted) || wanted === self.id.toLowerCase() || wanted === self.name.toLowerCase();

  if (!withPeers) return isLocal ? local : { kind: "elsewhere" };

  const peers = await db.query.meshPeers.findMany();
  const matches = peers.filter(
    (p) => p.id.toLowerCase() === wanted || p.instanceId.toLowerCase() === wanted || p.name.toLowerCase() === wanted
  );

  if (isLocal && matches.length === 0) return local;
  if (isLocal || matches.length > 1) {
    return { error: `"${ref}" matches more than one instance; pass its id from vardo_list_instances` };
  }
  if (matches.length === 0) {
    return { error: `No linked instance named "${ref}". vardo_list_instances lists them.` };
  }

  const [peer] = matches;
  if (peer.connectionType !== "direct") {
    return { error: `${peer.name} is only visible through a hub; link it directly to act on it` };
  }
  return { kind: "peer", peer, label: { id: peer.id, name: peer.name, local: false } };
}

export type InstanceSummary = {
  id: string;
  instanceId: string;
  name: string;
  local: boolean;
  url: string | null;
  type: string | null;
  role: string | null;
  version: string | null;
  healthy: boolean | null;
  status: string;
  lastSeenAt: string | null;
};

/** This instance first, then every directly linked peer. */
export async function listInstances({ includePeers }: { includePeers: boolean }): Promise<InstanceSummary[]> {
  const [self, config, policy] = await Promise.all([localIdentity(), getInstanceConfig(), getUpdatePolicy()]);
  const status = localVardoStatus();

  const local: InstanceSummary = {
    id: self.id,
    instanceId: self.id,
    name: self.name,
    local: true,
    url: config.domain ? `https://${config.domain}` : null,
    type: null,
    role: policy.canary.role === "none" ? null : policy.canary.role,
    version: status?.sha ?? null,
    healthy: status?.healthy ?? null,
    status: "online",
    lastSeenAt: null,
  };
  if (!includePeers) return [local];

  const peers = await db.query.meshPeers.findMany({
    columns: {
      id: true,
      instanceId: true,
      name: true,
      type: true,
      status: true,
      connectionType: true,
      publicApiUrl: true,
      vardoSha: true,
      vardoHealthy: true,
      lastSeenAt: true,
    },
  });

  return [
    local,
    ...peers
      .filter((p) => p.connectionType === "direct")
      .map((p) => ({
        id: p.id,
        instanceId: p.instanceId,
        name: p.name,
        local: false,
        url: p.publicApiUrl,
        type: p.type,
        role:
          policy.canary.role === "follower" && policy.canary.canaryInstanceId === p.instanceId ? "canary" : null,
        version: p.vardoSha,
        healthy: p.vardoHealthy,
        status: p.status,
        lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
      })),
  ];
}
