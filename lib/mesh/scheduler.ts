import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { sendHeartbeatToPeer } from "./heartbeat";
import { logger } from "@/lib/logger";

const log = logger.child("mesh-heartbeat");
const INTERVAL_MS = 30_000; // 30 seconds

/**
 * Start the mesh heartbeat scheduler.
 * Pings all known peers at a regular interval to maintain liveness tracking.
 */
export function startMeshHeartbeatScheduler(): void {
  let ticking = false;

  setInterval(async () => {
    if (ticking) return;
    ticking = true;

    try {
      const peers = await db.query.meshPeers.findMany({
        columns: { id: true, name: true },
      });

      if (peers.length === 0) return;

      const results = await Promise.allSettled(
        peers.map((peer) => sendHeartbeatToPeer(peer.id))
      );

      const online = results.filter(
        (r) => r.status === "fulfilled" && r.value === true
      ).length;
      const offline = peers.length - online;

      if (offline > 0) {
        log.debug(`Heartbeat: ${online}/${peers.length} peers online`);
      }
    } catch (err) {
      log.error("Heartbeat scheduler error:", err);
    } finally {
      ticking = false;
    }
  }, INTERVAL_MS);
}
