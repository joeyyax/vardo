// Persistent mesh peers that stop answering, or whose worker or watchdog goes quiet, as host incidents.

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { syncHostProblem, type HostProblem } from "@/lib/incidents/host";
import { logger } from "@/lib/logger";
import { uptimeClient } from "@/lib/uptime/client";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { WATCHDOG_SILENT_AFTER_MS, WORKER_DOWN_AFTER_MS } from "@/lib/worker/mode";

const log = logger.child("peer-watch");

/** A peer unreachable this long is silent. */
export const PEER_SILENT_AFTER_MS = 5 * 60_000;
const INTERVAL_MS = 60_000;

export type PeerReading = {
  lastSeenAt: Date | null;
  consoleAt: Date | null;
  workerAt: Date | null;
  watchdogAt: Date | null;
};

/** Null where the last report can't tell: the peer is silent or sent no heartbeats. */
export type PeerVerdict = { silent: boolean; workerDown: boolean | null; watchdogSilent: boolean | null };

/** Worker and watchdog ages compare against the peer's own console beat, so clock skew between hosts doesn't count. */
export function judgePeer(p: PeerReading, now: Date): PeerVerdict {
  const silent = !!p.lastSeenAt && now.getTime() - p.lastSeenAt.getTime() > PEER_SILENT_AFTER_MS;
  if (silent || !p.consoleAt) return { silent, workerDown: null, watchdogSilent: null };
  const consoleMs = p.consoleAt.getTime();
  return {
    silent,
    workerDown: !!p.workerAt && consoleMs - p.workerAt.getTime() > WORKER_DOWN_AFTER_MS,
    watchdogSilent: !!p.watchdogAt && consoleMs - p.watchdogAt.getTime() > WATCHDOG_SILENT_AFTER_MS,
  };
}

async function peerWatchPass(): Promise<void> {
  const peers = await db.query.meshPeers.findMany({
    where: and(eq(meshPeers.type, "persistent"), eq(meshPeers.connectionType, "direct")),
    columns: { id: true, instanceId: true, name: true, lastSeenAt: true, consoleAt: true, workerAt: true, watchdogAt: true },
  });
  const now = new Date();
  for (const peer of peers) {
    const verdict = judgePeer(peer, now);
    // Uptime raises the alert for a silent peer, with the cause, when it watches that peer.
    const uptimeAlerts = await uptimeClient.watchesPeer(peer.id).catch(() => false);
    const about = `peer:${peer.instanceId}`;
    const problems: [HostProblem, boolean | null, string][] = [
      [
        {
          kind: "host.peer-silent",
          about,
          title: `Mesh peer ${peer.name} is unreachable`,
          message: `${peer.name} hasn't answered a heartbeat in 5 minutes.`,
          severity: "critical",
        },
        uptimeAlerts ? false : verdict.silent,
        `${peer.name} is answering again.`,
      ],
      [
        {
          kind: "host.peer-worker-down",
          about,
          title: `Background worker down on ${peer.name}`,
          message: `${peer.name}'s console reports no worker heartbeat for 3 minutes.`,
          severity: "warning",
        },
        verdict.workerDown,
        `${peer.name}'s worker is running again.`,
      ],
      [
        {
          kind: "host.peer-watchdog-silent",
          about,
          title: `Watchdog stopped on ${peer.name}`,
          message: `${peer.name}'s watchdog hasn't ticked in 10 minutes.`,
          severity: "warning",
        },
        verdict.watchdogSilent,
        `${peer.name}'s watchdog is checking again.`,
      ],
    ];
    for (const [problem, active, recovered] of problems) {
      if (active === null) continue;
      try {
        await syncHostProblem(problem, active, recovered);
      } catch (err) {
        log.warn(`Couldn't update ${problem.kind} for ${peer.name}:`, err);
      }
    }
  }
}

export const peerWatchLoop = new IntervalLoop({
  name: "peer-watch",
  intervalMs: INTERVAL_MS,
  log,
  run: () => peerWatchPass(),
});
