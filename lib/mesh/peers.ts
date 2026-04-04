import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { allocateIp, toCidr } from "./ip-allocator";
import { generateMeshToken } from "./auth";
import { rebuildAndSync, isWireguardRunning } from "./wireguard";
import { CONSOLE_PORT } from "./constants";
import { logger } from "@/lib/logger";

interface RegisterPeerInput {
  instanceId: string;
  name: string;
  type: "persistent" | "dev";
  publicKey: string;
  endpoint?: string | null;
}

interface RegisterPeerResult {
  peer: typeof meshPeers.$inferInsert & { id: string };
  token: string;
}

/** Register a new mesh peer — shared between admin add and invite join flows. */
export async function registerPeer(
  input: RegisterPeerInput
): Promise<RegisterPeerResult> {
  // Allocate a tunnel IP
  const allPeers = await db.query.meshPeers.findMany({
    columns: { internalIp: true },
  });
  const internalIp = allocateIp(allPeers.map((p) => p.internalIp));

  // Generate a service-to-service token
  const { raw: token, hash: tokenHash } = generateMeshToken();

  const peer = {
    id: nanoid(),
    instanceId: input.instanceId,
    name: input.name,
    type: input.type,
    publicKey: input.publicKey,
    endpoint: input.endpoint ?? null,
    allowedIps: toCidr(internalIp),
    internalIp,
    apiUrl: `http://${internalIp}:${CONSOLE_PORT}`,
    tokenHash,
    status: "offline" as const,
    lastSeenAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  await db.insert(meshPeers).values(peer);

  // Rebuild WireGuard config with the new peer
  try {
    if (await isWireguardRunning()) {
      await rebuildAndSync();
    }
  } catch (err) {
    logger.warn(`[mesh] WireGuard sync failed after registering peer ${peer.name}: ${err}`);
  }

  return { peer, token };
}
