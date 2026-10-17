import { db } from "@/lib/db";
import { sendHeartbeatToPeer } from "./heartbeat";
import { reconcileConsoleForward } from "./console-forward";
import { reconcileSshForward } from "./ssh-forward";
import { reconcileTraefikForward } from "./traefik-forward";
import { syncAuthorizedKeys } from "./ssh-endpoint";
import { syncBuilderTls } from "./builder-tls";
import { reconcileBuilderForward } from "./builder-forward";
import { exchangeSshKeys } from "./ssh-exchange";
import { logger } from "@/lib/logger";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("mesh-heartbeat");
const INTERVAL_MS = 30_000;
const FIRST_FORWARD_CHECK_MS = 5_000;

async function reconcileForward(): Promise<void> {
  try {
    await reconcileConsoleForward();
  } catch (err) {
    log.error("Mesh console forward check failed:", err);
  }
  try {
    await reconcileSshForward();
    await syncAuthorizedKeys();
  } catch (err) {
    log.error("Mesh SSH endpoint check failed:", err);
  }
  try {
    await syncBuilderTls();
    await reconcileBuilderForward();
  } catch (err) {
    log.error("Mesh builder check failed:", err);
  }
  try {
    await reconcileTraefikForward();
  } catch (err) {
    log.error("Mesh Traefik forward check failed:", err);
  }
}

/** Heartbeat, then trade SSH keys with a peer that answered. */
async function heartbeatAndKeys(peerId: string): Promise<boolean> {
  const ok = await sendHeartbeatToPeer(peerId);
  if (ok) await exchangeSshKeys(peerId).catch(() => {});
  return ok;
}

async function heartbeatPass(): Promise<void> {
  const peers = await db.query.meshPeers.findMany({
    columns: { id: true, name: true },
  });

  if (peers.length === 0) return;

  await reconcileForward();

  const results = await Promise.allSettled(
    peers.map((peer) => heartbeatAndKeys(peer.id))
  );

  const online = results.filter(
    (r) => r.status === "fulfilled" && r.value === true
  ).length;
  const offline = peers.length - online;

  if (offline > 0) {
    log.debug(`Heartbeat: ${online}/${peers.length} peers online`);
  }
}

export const meshHeartbeatLoop = new IntervalLoop({
  name: "mesh-heartbeat",
  intervalMs: INTERVAL_MS,
  log,
  // A restarted console can come back on a different mesh IP.
  prepare: async () => {
    setTimeout(() => {
      db.query.meshPeers.findFirst({ columns: { id: true } })
        .then((peer) => (peer ? reconcileForward() : undefined))
        .catch(() => {});
    }, FIRST_FORWARD_CHECK_MS).unref?.();
  },
  run: heartbeatPass,
});
