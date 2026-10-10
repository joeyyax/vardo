import { db } from "@/lib/db";
import { sendHeartbeatToPeer } from "./heartbeat";
import { reconcileConsoleForward } from "./console-forward";
import { logger } from "@/lib/logger";

const log = logger.child("mesh-heartbeat");
const INTERVAL_MS = 30_000;
const FIRST_FORWARD_CHECK_MS = 5_000;

async function reconcileForward(): Promise<void> {
  try {
    await reconcileConsoleForward();
  } catch (err) {
    log.error("Mesh console forward check failed:", err);
  }
}

/** Start the mesh heartbeat scheduler. */
export function startMeshHeartbeatScheduler(): void {
  let ticking = false;

  // A restarted console can come back on a different mesh IP.
  setTimeout(() => {
    db.query.meshPeers.findFirst({ columns: { id: true } })
      .then((peer) => (peer ? reconcileForward() : undefined))
      .catch(() => {});
  }, FIRST_FORWARD_CHECK_MS);

  setInterval(async () => {
    if (ticking) return;
    ticking = true;

    try {
      const peers = await db.query.meshPeers.findMany({
        columns: { id: true, name: true },
      });

      if (peers.length === 0) return;

      await reconcileForward();

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
