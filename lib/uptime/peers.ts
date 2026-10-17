// Instance monitors for linked peers: the peer's console over the tunnel and its public URL, read with the mesh heartbeat into one verdict.

import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers, uptimeMonitors, uptimeResults, type UptimeMonitorRow } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { CONSOLE_PORT } from "@/lib/mesh/constants";
import { openUptimeIncident, resolveUptimeIncident } from "@/lib/incidents/uptime";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { getInstanceDisplayName } from "@/lib/system-settings";
import {
  DEFAULT_EXPECTED_STATUS,
  evaluate,
  judgePeerLink,
  type Check,
  type PeerVerdict,
  type PeerVerdictKind,
  type Signal,
} from "./core";
import { tunnelAddress } from "./mesh-path";
import { toResult } from "./service";
import { listVantagePoints } from "./vantage";

const log = logger.child("uptime-peers");

/** A heartbeat older than this is stale. */
const HEARTBEAT_FRESH_MS = 5 * 60_000;
const RECENT_MS = 15 * 60_000;
const KINDS: PeerVerdictKind[] = ["link-down", "peer-down", "unreachable", "public-down"];

export const linkMonitorId = (peerId: string) => `mon_peer_link_${peerId}`;
export const publicMonitorId = (peerId: string) => `mon_peer_pub_${peerId}`;

const health = (url: string): Check => ({ type: "http", url, expectedStatus: { ...DEFAULT_EXPECTED_STATUS }, timeoutMs: 5000 });

/** The peer's console health over the tunnel, or null without a valid tunnel address. */
export function linkCheck(internalIp: string): Check | null {
  const address = tunnelAddress(internalIp);
  return address ? health(`http://${address}:${CONSOLE_PORT}/api/health`) : null;
}

/** The peer's public health URL, or null when it has no HTTPS one. */
export function publicCheck(publicApiUrl: string | null): Check | null {
  if (!publicApiUrl?.startsWith("https://")) return null;
  try {
    return health(new URL("/api/health", publicApiUrl).toString());
  } catch {
    return null;
  }
}

type PeerRow = { id: string; name: string; internalIp: string; publicApiUrl: string | null; lastSeenAt: Date | null };

async function livePeers(): Promise<PeerRow[]> {
  return db.query.meshPeers.findMany({
    where: and(eq(meshPeers.connectionType, "direct"), eq(meshPeers.type, "persistent")),
    columns: { id: true, name: true, internalIp: true, publicApiUrl: true, lastSeenAt: true },
  });
}

/** Creates, updates and removes the peer monitors. Returns the ids to keep among the automatic monitors. */
export async function syncPeerMonitors(existing: UptimeMonitorRow[]): Promise<{ keep: string[]; added: number }> {
  const byId = new Map(existing.map((m) => [m.id, m]));
  const keep: string[] = [];
  let added = 0;
  for (const peer of await livePeers()) {
    const wanted: { id: string; role: "link" | "public"; name: string; check: Check | null }[] = [
      { id: linkMonitorId(peer.id), role: "link", name: `Link to ${peer.name}`, check: linkCheck(peer.internalIp) },
      { id: publicMonitorId(peer.id), role: "public", name: `${peer.name} public URL`, check: publicCheck(peer.publicApiUrl) },
    ];
    for (const w of wanted) {
      if (!w.check) continue;
      keep.push(w.id);
      const current = byId.get(w.id);
      if (!current) {
        await db
          .insert(uptimeMonitors)
          .values({ id: w.id, organizationId: null, name: w.name, check: w.check, source: "auto", meshPeerId: peer.id, peerRole: w.role })
          .onConflictDoNothing();
        added++;
      } else if (current.name !== w.name || JSON.stringify(current.check) !== JSON.stringify(w.check)) {
        await db.update(uptimeMonitors).set({ name: w.name, check: w.check, updatedAt: new Date() }).where(eq(uptimeMonitors.id, w.id));
      }
    }
  }
  return { keep, added };
}

/** True when uptime watches this peer, so the heartbeat watcher leaves its silence to uptime. */
export async function watchesPeer(peerId: string): Promise<boolean> {
  const row = await db.query.uptimeMonitors.findFirst({
    where: and(eq(uptimeMonitors.id, linkMonitorId(peerId)), eq(uptimeMonitors.enabled, true)),
    columns: { id: true },
  });
  return !!row;
}

const signal = (state: string): Signal => (state === "up" || state === "down" ? state : state === "degraded" ? "down" : "unknown");

/** Every watched peer's verdict from the latest results. */
export async function peerVerdicts(peerIds: string[], now: number): Promise<Map<string, PeerVerdict>> {
  const out = new Map<string, PeerVerdict>();
  if (peerIds.length === 0) return out;
  const peers = (await livePeers()).filter((p) => peerIds.includes(p.id));
  const ids = peers.flatMap((p) => [linkMonitorId(p.id), publicMonitorId(p.id)]);
  const [monitors, rows, vantages, self] = await Promise.all([
    db.select().from(uptimeMonitors).where(inArray(uptimeMonitors.id, ids)),
    db.select().from(uptimeResults).where(and(inArray(uptimeResults.monitorId, ids), gte(uptimeResults.at, new Date(now - RECENT_MS)))),
    listVantagePoints(),
    getInstanceDisplayName().catch(() => null),
  ]);
  const results = rows.map(toResult);
  const stateOf = (id: string): Signal | "none" => {
    const m = monitors.find((x) => x.id === id);
    if (!m || !m.enabled) return "none";
    const own = results.filter((r) => r.monitorId === id);
    return signal(evaluate({ vantages, results: own, now, intervalSec: m.intervalSec }).state);
  };
  for (const p of peers) {
    const tunnel = stateOf(linkMonitorId(p.id));
    if (tunnel === "none") continue;
    out.set(
      p.id,
      judgePeerLink({
        peer: p.name,
        self: self || "this instance",
        tunnel,
        publicUrl: stateOf(publicMonitorId(p.id)),
        heartbeatFresh: p.lastSeenAt ? now - p.lastSeenAt.getTime() < HEARTBEAT_FRESH_MS : null,
      }),
    );
  }
  return out;
}

/** Opens the incident for each peer's current verdict and resolves the ones it no longer holds. `silent` says whether alerts are muted for a monitor. */
export async function syncPeerAlerts(peerIds: string[], now: number, silent: (m: UptimeMonitorRow) => boolean): Promise<void> {
  const verdicts = await peerVerdicts(peerIds, now);
  if (verdicts.size === 0) return;
  const orgIds = await adminOrgIds();
  for (const [peerId, verdict] of verdicts) {
    try {
      const monitorId = linkMonitorId(peerId);
      const about = (kind: string) => `${monitorId}#${kind}`;
      if (verdict.state === "unknown") continue;
      for (const kind of KINDS) {
        if (kind !== verdict.kind) await resolveUptimeIncident({ about: about(kind), orgIds }, "Reachable again.");
      }
      if (verdict.kind === "ok") continue;
      const monitor = await db.query.uptimeMonitors.findFirst({ where: eq(uptimeMonitors.id, monitorId) });
      if (!monitor || silent(monitor)) continue;
      await openUptimeIncident(
        { about: about(verdict.kind), title: verdict.title, orgIds, severity: verdict.state === "down" ? "critical" : "warning" },
        verdict.detail,
      );
    } catch (err) {
      log.error(`Peer alert sync for ${peerId} failed:`, err);
    }
  }
}
