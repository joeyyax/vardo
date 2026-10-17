// Reports between linked instances on the monitors a peer doesn't check itself. The owner sends signed state, timings, container health
// and outages once a minute over the signed mesh channel; the watching peer alerts from them, and when they stop.

import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, meshPeers, uptimeMonitors, uptimePeerReports, uptimeResults, uptimeVantages } from "@/lib/db/schema";
import type { AppCondition } from "@/lib/docker/conditions";
import { openUptimeIncident, resolveUptimeIncident } from "@/lib/incidents/uptime";
import { logger } from "@/lib/logger";
import { MeshClientError, meshSignedPost } from "@/lib/mesh/client";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import {
  DAY_MS,
  REPORT_EVERY_MS,
  effectiveIntervalSec,
  evaluate,
  findOutages,
  median,
  monitorReport,
  newMemory,
  readReport,
  reportEntry,
  reportFreshness,
  reportObservation,
  signRecord,
  stepDamping,
  verifyRecord,
  type ContainerState,
  type DampMemory,
  type MonitorReport,
  type Notice,
  type Outage,
  type ReportedMonitor,
} from "./core";
import { appNotRunning, runStateColumns } from "./auto";
import { localIdentity } from "./identity";
import { REPORTS_PATH, reportRequestSchema, validKey, type LinkReply } from "./link";
import { publicEntries, type Resolver } from "./net";
import { queueNotice } from "./notices";
import { confirmWatched, knownKey } from "./prober";
import { toResult } from "./service";
import { listVantagePoints, localSigningKey } from "./vantage";
import { externalWatchers, loadImpaired, sharing } from "./watchers";

const log = logger.child("uptime-reports");

const RECENT_MS = 15 * 60_000;
/** How long the set of reported monitors and their outages are reused before they're worked out again. */
const SET_REFRESH_MS = 5 * 60_000;
const OUTAGE_REFRESH_MS = 10 * 60_000;
/** A peer whose reports stopped is asked whether it still lets us watch it, at most this often. */
const CONFIRM_EVERY_MS = 60_000;
const PUSH_TIMEOUT_MS = 15_000;

const reply = (status: number, json: unknown): LinkReply => ({ status, json });

// ---- Owner side ----

let lastPush = 0;
let reportedSet: { at: number; ids: Set<string> } | null = null;
let outageCache: { at: number; byMonitor: Map<string, Outage[]> } | null = null;

const RUNTIME_KINDS = new Set(["crash-looping", "self-heal-exhausted", "unhealthy"]);

/** The container's health from the app's conditions: crash-looping outranks unhealthy. */
export function containerState(conditions: AppCondition[] | null | undefined): ContainerState {
  const kinds = new Set((conditions ?? []).map((c) => c.kind).filter((k) => RUNTIME_KINDS.has(k)));
  if (kinds.has("crash-looping") || kinds.has("self-heal-exhausted")) return "crash-looping";
  return kinds.has("unhealthy") ? "unhealthy" : "healthy";
}

const inMaintenance = (windows: { start: number; end: number }[], now: number) => windows.some((w) => now >= w.start && now < w.end);

/** Monitor ids that no peer checks: their host has no public address, or their headers stay on this instance. */
async function unwatchedIds(live: (typeof uptimeMonitors.$inferSelect)[], now: number, resolve?: Resolver): Promise<Set<string>> {
  if (!resolve && reportedSet && now - reportedSet.at < SET_REFRESH_MS) return reportedSet.ids;
  const shareable = live.filter((m) => m.headerNames.length === 0 || m.shareHeaders);
  const served = new Set((await publicEntries(shareable, resolve)).map((e) => e.monitorId));
  const ids = new Set(live.filter((m) => !served.has(m.id)).map((m) => m.id));
  reportedSet = { at: now, ids };
  return ids;
}

async function outagesFor(ids: string[], now: number, ctx: { intervalOf: (id: string) => number }): Promise<Map<string, Outage[]>> {
  if (outageCache && now - outageCache.at < OUTAGE_REFRESH_MS && ids.every((id) => outageCache!.byMonitor.has(id))) return outageCache.byMonitor;
  const from = now - DAY_MS;
  const [vantages, rows] = await Promise.all([
    listVantagePoints(),
    ids.length ? db.select().from(uptimeResults).where(and(inArray(uptimeResults.monitorId, ids), gte(uptimeResults.at, new Date(from)))) : Promise.resolve([]),
  ]);
  const results = rows.map(toResult);
  const byMonitor = new Map(ids.map((id) => [id, findOutages({ results: results.filter((r) => r.monitorId === id), vantages, intervalSec: ctx.intervalOf(id), from, to: now })]));
  outageCache = { at: now, byMonitor };
  return byMonitor;
}

/** This instance's report: every enabled monitor peers don't check, by host, with its state as this instance sees it. */
export async function buildReport(now = Date.now(), resolve?: Resolver): Promise<ReportedMonitor[]> {
  const rows = await db
    .select({ monitor: uptimeMonitors, app: runStateColumns, conditions: apps.conditions })
    .from(uptimeMonitors)
    .leftJoin(apps, eq(apps.id, uptimeMonitors.appId))
    .where(eq(uptimeMonitors.enabled, true));
  const live = rows.filter(({ monitor, app }) => !(monitor.appId && appNotRunning(app)) && !monitor.meshPeerId);
  const ids = await unwatchedIds(live.map((r) => r.monitor), now, resolve);
  const reported = live.filter((r) => ids.has(r.monitor.id));
  if (reported.length === 0) return [];

  const [vantages, recent, watchers, impaired] = await Promise.all([
    listVantagePoints(),
    db.select().from(uptimeResults).where(and(inArray(uptimeResults.monitorId, reported.map((r) => r.monitor.id)), gte(uptimeResults.at, new Date(now - RECENT_MS)))),
    externalWatchers(),
    loadImpaired(now),
  ]);
  const results = recent.map(toResult);
  const intervalOf = (id: string) => effectiveIntervalSec(reported.find((r) => r.monitor.id === id)!.monitor.intervalSec, sharing(watchers, id).length);
  const outages = await outagesFor(reported.map((r) => r.monitor.id), now, { intervalOf });

  const out: ReportedMonitor[] = [];
  for (const { monitor: m, conditions } of reported) {
    const own = results.filter((r) => r.monitorId === m.id);
    const evaluation = evaluate({ vantages, results: own, now, intervalSec: intervalOf(m.id), impaired });
    const entry = reportEntry({
      monitorId: m.id,
      check: m.check,
      state: evaluation.state,
      downSince: evaluation.downSince,
      latencyMs: median(own.filter((r) => r.ok).map((r) => r.latencyMs)),
      container: m.appId ? containerState(conditions) : null,
      outages: outages.get(m.id) ?? [],
      quiet: m.muted || inMaintenance(m.maintenance, now) || (m.reviewStatus !== null && m.reviewAnswer === null),
    });
    if (entry) out.push(entry);
  }
  return out;
}

/** Once a minute, sends the signed report to every linked peer this instance lets check it, and notes which ones took it. */
export async function pushReports(now = Date.now(), force = false): Promise<void> {
  if (!force && now - lastPush < REPORT_EVERY_MS - 1000) return;
  lastPush = now;
  const peers = await db.query.meshPeers.findMany({
    where: and(eq(meshPeers.connectionType, "direct"), eq(meshPeers.uptimeChecksUs, true)),
    columns: { id: true, name: true },
  });
  if (peers.length === 0) return;

  const monitors = await buildReport(now);
  const identity = await localIdentity();
  const report = signRecord(monitorReport(identity.id, monitors, now), await localSigningKey());
  const ids = monitors.map((m) => m.monitorId);
  await Promise.all(
    peers.map(async (peer) => {
      try {
        await meshSignedPost(peer.id, REPORTS_PATH, { vantage: identity, report }, { timeoutMs: PUSH_TIMEOUT_MS, probeMs: 2000 });
        await db.update(uptimeVantages).set({ reporting: ids, reportedAt: new Date(now) }).where(eq(uptimeVantages.meshPeerId, peer.id));
      } catch (err) {
        // A peer that doesn't watch us, or predates reports, says so; it isn't an error.
        if (err instanceof MeshClientError && (err.statusCode === 403 || err.statusCode === 404)) {
          await db.update(uptimeVantages).set({ reporting: [], reportedAt: null }).where(eq(uptimeVantages.meshPeerId, peer.id));
          return;
        }
        log.warn(`Report to ${peer.name} failed: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );
}

// ---- Watching side ----

/** A peer sends its signed report. It's checked against the key the peer announced, then stored untouched. */
export async function receiveReport(peerId: string, body: unknown, now = Date.now()): Promise<LinkReply> {
  const peer = await db.query.meshPeers.findFirst({ where: eq(meshPeers.id, peerId), columns: { id: true, uptimeChecksPeer: true } });
  if (!peer || !peer.uptimeChecksPeer) return reply(403, { error: "This instance doesn't watch you" });

  const parsed = reportRequestSchema.safeParse(body);
  if (!parsed.success || !validKey(parsed.data.vantage.publicKey)) return reply(400, { error: "Invalid report" });
  const { vantage, report } = parsed.data;
  const known = await knownKey(peer.id);
  if (known && known !== vantage.publicKey) return reply(403, { error: "Vantage key changed" });

  const payload = verifyRecord(report, vantage.publicKey);
  if (!payload || payload.kind !== "report" || payload.vantageId !== vantage.id) return reply(400, { error: "Bad report signature" });

  const existing = await db.query.uptimePeerReports.findFirst({ where: eq(uptimePeerReports.peerId, peer.id), columns: { issuedAt: true } });
  const read = readReport(payload, now, existing?.issuedAt.getTime() ?? null);
  if ("error" in read) {
    log.warn(`Refused a report from peer ${peer.id}: ${read.error}`);
    return reply(400, { error: read.error });
  }

  const row = { remoteId: vantage.id, publicKey: vantage.publicKey, issuedAt: new Date(payload.issuedAt), receivedAt: new Date(now), payload: report.payload, sig: report.sig };
  await db.insert(uptimePeerReports).values({ peerId: peer.id, ...row }).onConflictDoUpdate({ target: uptimePeerReports.peerId, set: row });
  await syncReportAlerts(now, [peer.id]).catch((err) => log.error("Report alert sync failed:", err));
  return reply(200, { accepted: read.monitors.length });
}

type Tracked = { memory: DampMemory; host: string };
/** Damping per reported monitor, by peer. */
const tracked = new Map<string, Map<string, Tracked>>();
const lastConfirm = new Map<string, number>();

/** The incident subject for a monitor a peer reported. */
export const reportedAbout = (peerId: string, monitorId: string) => `report:${peerId}:${monitorId}`;

function containerNote(c: ContainerState | null): string {
  return c === "crash-looping" ? " Its container is crash-looping." : c === "unhealthy" ? " Its container's healthcheck is failing." : "";
}

/** Whether each peer's reports are arriving, for the peer verdicts. Peers we don't watch, or that never reported, are absent. */
export async function reportSignals(peerIds: string[], now: number): Promise<Map<string, "fresh" | "stale">> {
  if (peerIds.length === 0) return new Map();
  const rows = await db
    .select({ peerId: uptimePeerReports.peerId, receivedAt: uptimePeerReports.receivedAt })
    .from(uptimePeerReports)
    .innerJoin(meshPeers, eq(meshPeers.id, uptimePeerReports.peerId))
    .where(and(inArray(uptimePeerReports.peerId, peerIds), eq(meshPeers.uptimeChecksPeer, true)));
  return new Map(rows.map((r) => [r.peerId, reportFreshness(r.receivedAt.getTime(), now) as "fresh" | "stale"]));
}

async function resolveQuietly(peerId: string, monitorId: string, t: Tracked, orgIds: string[]): Promise<void> {
  if (t.memory.announced) await resolveUptimeIncident({ about: reportedAbout(peerId, monitorId), orgIds }, "", { notify: false });
}

/**
 * Opens and resolves incidents from each watched peer's latest report, through the same damping as this instance's own monitors.
 * A stale report changes nothing here: the peer verdict says it stopped. A peer that no longer lets us watch it has its report dropped.
 */
export async function syncReportAlerts(now = Date.now(), only?: string[]): Promise<void> {
  const rows = await db
    .select({ report: uptimePeerReports, name: meshPeers.name, watching: meshPeers.uptimeChecksPeer })
    .from(uptimePeerReports)
    .innerJoin(meshPeers, eq(meshPeers.id, uptimePeerReports.peerId));
  const orgIds = await adminOrgIds();
  const present = new Set<string>();

  for (const { report: row, name, watching } of rows) {
    if (only && !only.includes(row.peerId)) {
      present.add(row.peerId);
      continue;
    }
    try {
      if (!watching) continue;
      if (reportFreshness(row.receivedAt.getTime(), now) === "stale") {
        present.add(row.peerId);
        if (now - (lastConfirm.get(row.peerId) ?? 0) >= CONFIRM_EVERY_MS) {
          lastConfirm.set(row.peerId, now);
          if ((await confirmWatched(row.peerId, now)) === "refused") present.delete(row.peerId);
        }
        continue;
      }
      present.add(row.peerId);
      const payload = JSON.parse(row.payload) as MonitorReport;
      const mine = tracked.get(row.peerId) ?? new Map<string, Tracked>();
      tracked.set(row.peerId, mine);
      const seen = new Set<string>();
      for (const m of payload.monitors) {
        seen.add(m.monitorId);
        const t = mine.get(m.monitorId) ?? { memory: newMemory(), host: m.host };
        t.host = m.host;
        mine.set(m.monitorId, t);
        if (m.quiet) {
          await resolveQuietly(row.peerId, m.monitorId, t, orgIds);
          t.memory = newMemory();
          continue;
        }
        const before = t.memory;
        const { memory, actions } = stepDamping(before, reportObservation(m), now);
        t.memory = memory;
        if (actions.length === 0) continue;

        const about = reportedAbout(row.peerId, m.monitorId);
        const title = `${m.host} on ${name} is ${m.state === "degraded" ? "degraded" : "down"}`;
        const outage = { about, name: m.host, title, orgIds, severity: m.state === "degraded" ? ("warning" as const) : ("critical" as const) };
        const say = (kind: Notice["kind"], noticeTitle: string, detail: string) =>
          queueNotice({ at: now, kind, audience: orgIds.join(","), monitorId: about, name: m.host, title: noticeTitle, detail, instance: name });
        for (const action of actions) {
          if (action.kind === "open") {
            if (before.announced) await resolveUptimeIncident(outage, "", { notify: false });
            const detail = `${name} reports ${m.host} ${m.state === "degraded" ? "degraded" : "isn't responding"}.${containerNote(m.container)}`;
            await openUptimeIncident(outage, detail, { notify: false });
            if (action.notify) say("down", title, detail);
          } else if (action.kind === "resolve") {
            const wasOpen = await resolveUptimeIncident(outage, "", { notify: false });
            if (action.notify || (action.stale && wasOpen)) say("recovered", `${m.host} on ${name} is responding again`, `${name} reports ${m.host} responding again.`);
          } else if (action.kind === "flapping") {
            say("flapping", `${m.host} on ${name} is flapping`, `${name} reports ${m.host} changing state more than 3 times in 30 minutes. Notices pause until it has been stable for 15 minutes.`);
          } else {
            const word = action.state === "up" ? "up" : action.state === "down" ? "down" : "degraded";
            say("settled", `${m.host} on ${name} settled: ${word}`, `${name} reports ${m.host} stable for 15 minutes and ${word}.`);
          }
        }
      }
      // A monitor the owner stopped reporting, such as one it removed, closes without a notice.
      for (const [monitorId, t] of mine) {
        if (seen.has(monitorId)) continue;
        await resolveQuietly(row.peerId, monitorId, t, orgIds);
        mine.delete(monitorId);
      }
    } catch (err) {
      log.error(`Report alert sync for ${row.peerId} failed:`, err);
    }
  }

  // Peers whose report is gone, or that we no longer watch, close their incidents without a notice.
  for (const [peerId, mine] of tracked) {
    if (present.has(peerId)) continue;
    for (const [monitorId, t] of mine) await resolveQuietly(peerId, monitorId, t, orgIds);
    tracked.delete(peerId);
  }
}
