// What the worker runs: due checks from the local vantage point, rollups, alerts, retention and auto monitors.

import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { isFeatureEnabled } from "@/lib/config/features";
import { db } from "@/lib/db";
import { apps, domains, environments, meshPeers, uptimeDaily, uptimeHourly, uptimeMonitors, uptimePeerReports, uptimeRecords, uptimeResults } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { consoleBaseUrl } from "@/lib/incidents/key";
import { openUptimeIncident, resolveUptimeIncident } from "@/lib/incidents/uptime";
import { CONSOLE_PORT } from "@/lib/mesh/constants";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { nanoid } from "nanoid";
import {
  DAY_MS,
  AUTO_EXPECTED_STATUS,
  DEFAULT_HTTP_TIMEOUT_MS,
  HOUR_MS,
  isNeverPublic,
  combine,
  evaluate,
  hourlySummary,
  effectiveIntervalSec,
  isDueAt,
  markImpaired,
  newMemory,
  stepDamping,
  staggerOf,
  runCheck,
  signRecord,
  summarize,
  type Bucket,
  type CheckResult,
  type DampMemory,
  type HttpCheck,
  type Monitor,
  type Notice,
} from "./core";
import { incidentTitle, readingDetail } from "./format";
import { tunnelAddress, tunnelDeps } from "./mesh-path";
import { checkDeps, levelOf } from "./outbound";
import { syncPeerAlerts, syncPeerMonitors } from "./peers";
import { queueNotice, flushNotices } from "./notices";
import { appNotRunning, runStateColumns, autoCheckFor, autoIntervalFor, sameAutoFields, withAutoFields } from "./auto";
import { runHealthDetection } from "./health";
import { openHeaders } from "./secrets";
import { externalWatchers, loadImpaired, sharing } from "./watchers";
import { pruneProbes, tickProber } from "./prober";
import { pushReports, syncReportAlerts } from "./reports";
import { toResult } from "./service";
import { LOCAL_VANTAGE_ID, ensureLocalVantage, listVantagePoints, localSigningKey } from "./vantage";

const log = logger.child("uptime");

const RAW_RETENTION_MS = 14 * DAY_MS;
const HOURLY_RETENTION_MS = 365 * DAY_MS;
const RECENT_MS = 15 * 60_000;
const CONCURRENCY = 4;
const CONSOLE_MONITOR_ID = "mon_console";

const lastRun = new Map<string, number>();
const damping = new Map<string, DampMemory>();
let seeded = false;
let lastRollup = 0;
let lastReeval = 0;
let lastPrune = 0;

const httpCheck = (url: string): HttpCheck => ({
  type: "http",
  url,
  expectedStatus: { ...AUTO_EXPECTED_STATUS },
  timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
});

const sameStatus = (a: { min: number; max: number }, b: { min: number; max: number }) => a.min === b.min && a.max === b.max;

function domainUrl(d: { domain: string; pathPrefix: string | null; sslEnabled: boolean | null }): string {
  return `${d.sslEnabled === false ? "http" : "https"}://${d.domain}${d.pathPrefix ?? ""}`;
}

/** Creates, updates and removes auto monitors to match the apps' domains, previews and the console. */
export async function syncAutoMonitors(): Promise<{ added: number; removed: number }> {
  let added = 0;
  let removed = 0;

  // With the domain-monitoring flag off, domain monitors pause: none are added, checked or removed.
  const domainsOn = isFeatureEnabled("domain-monitoring");
  const domainRows = !domainsOn ? [] : await db
    .select({
      id: domains.id,
      domain: domains.domain,
      pathPrefix: domains.pathPrefix,
      sslEnabled: domains.sslEnabled,
      appId: domains.appId,
      orgId: apps.organizationId,
      app: runStateColumns,
    })
    .from(domains)
    .innerJoin(apps, eq(apps.id, domains.appId))
    .where(eq(domains.enabled, true));

  const previewRows = await db
    .select({ id: environments.id, domain: environments.domain, appId: environments.appId, orgId: apps.organizationId, app: runStateColumns })
    .from(environments)
    .innerJoin(apps, eq(apps.id, environments.appId))
    .where(and(eq(environments.type, "preview"), isNotNull(environments.domain), eq(apps.isSystemManaged, false)));

  const existing = await db.select().from(uptimeMonitors).where(eq(uptimeMonitors.source, "auto"));
  const byDomain = new Map(existing.filter((m) => m.domainId).map((m) => [m.domainId!, m]));
  const byEnv = new Map(existing.filter((m) => m.environmentId).map((m) => [m.environmentId!, m]));

  const wanted: { key: string; running: boolean; row: typeof uptimeMonitors.$inferInsert }[] = [];
  // Domains that can't be public get no monitor, and lose the one they had.
  for (const d of domainRows.filter((r) => !isNeverPublic(r.domain))) {
    const url = domainUrl(d);
    wanted.push({
      key: `d:${d.id}`,
      running: !appNotRunning(d.app),
      row: { id: `mon_${nanoid(16)}`, organizationId: d.orgId, name: d.domain + (d.pathPrefix ?? ""), check: httpCheck(url), source: "auto", appId: d.appId, domainId: d.id },
    });
  }
  for (const p of previewRows.filter((r) => !isNeverPublic(r.domain!))) {
    wanted.push({
      key: `e:${p.id}`,
      running: !appNotRunning(p.app),
      row: { id: `mon_${nanoid(16)}`, organizationId: p.orgId, name: p.domain!, check: httpCheck(`https://${p.domain}`), source: "auto", appId: p.appId, environmentId: p.id, preview: true },
    });
  }

  const keep = new Set<string>();
  if (!domainsOn) for (const m of byDomain.values()) keep.add(m.id);
  for (const w of wanted) {
    const current = w.key.startsWith("d:") ? byDomain.get(w.row.domainId!) : byEnv.get(w.row.environmentId!);
    if (!current) {
      await db.insert(uptimeMonitors).values(w.row).onConflictDoNothing();
      added++;
      continue;
    }
    keep.add(current.id);
    // The base address follows the domain; the detected path, the operator's answer and their edits stay.
    const check = autoCheckFor(current, (w.row.check as HttpCheck).url);
    const name = current.overrides?.name ?? (w.row.name as string);
    const intervalSec = autoIntervalFor(current);
    const prev = current.check.type === "http" ? current.check : null;
    const same = prev && sameAutoFields(prev, check);
    // A question asked while the app wasn't running is about Vardo's catch-all, not the app; detection asks again once it runs.
    const staleReview = !w.running && current.reviewStatus !== null && current.reviewAnswer === null;
    if (!same || current.name !== name || current.organizationId !== w.row.organizationId || current.intervalSec !== intervalSec || staleReview) {
      await db
        .update(uptimeMonitors)
        .set({
          check: prev ? withAutoFields(prev, check) : check,
          name,
          intervalSec,
          organizationId: w.row.organizationId,
          ...(staleReview ? { reviewStatus: null, reviewReason: null, healthDueAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(uptimeMonitors.id, current.id));
    }
  }

  // Console: one instance monitor.
  const consoleUrl = `${consoleBaseUrl()}/api/health`;
  const consoleRow = existing.find((m) => m.id === CONSOLE_MONITOR_ID);
  keep.add(CONSOLE_MONITOR_ID);
  if (!consoleRow) {
    await db
      .insert(uptimeMonitors)
      .values({ id: CONSOLE_MONITOR_ID, organizationId: null, name: "Vardo console", check: httpCheck(consoleUrl), source: "auto" })
      .onConflictDoNothing();
    added++;
  } else if (consoleRow.check.type === "http" && (consoleRow.check.url !== consoleUrl || !sameStatus(consoleRow.check.expectedStatus, AUTO_EXPECTED_STATUS))) {
    await db.update(uptimeMonitors).set({ check: { ...consoleRow.check, url: consoleUrl, expectedStatus: { ...AUTO_EXPECTED_STATUS } }, updatedAt: new Date() }).where(eq(uptimeMonitors.id, CONSOLE_MONITOR_ID));
  }

  const peers = await syncPeerMonitors(existing);
  for (const id of peers.keep) keep.add(id);
  added += peers.added;

  for (const m of existing) {
    if (keep.has(m.id)) continue;
    await db.delete(uptimeMonitors).where(eq(uptimeMonitors.id, m.id));
    lastRun.delete(m.id);
    removed++;
  }
  return { added, removed };
}

async function seedLastRun(): Promise<void> {
  if (seeded) return;
  seeded = true;
  const rows = await db
    .select({ monitorId: uptimeResults.monitorId, at: sql<Date>`max(${uptimeResults.at})` })
    .from(uptimeResults)
    .where(and(eq(uptimeResults.vantageId, LOCAL_VANTAGE_ID), gte(uptimeResults.at, new Date(Date.now() - 10 * 60_000))))
    .groupBy(uptimeResults.monitorId);
  for (const r of rows) lastRun.set(r.monitorId, new Date(r.at).getTime());
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export function inMaintenance(m: Pick<Monitor, "maintenance">, now: number): boolean {
  return (m.maintenance ?? []).some((w) => now >= w.start && now < w.end);
}

/** Runs the checks that are due, stores them, and opens or resolves incidents. */
export async function runDueChecks(now = Date.now(), clock?: () => number): Promise<number> {
  await seedLastRun();
  const local = await ensureLocalVantage();
  const rows = await db
    .select({ monitor: uptimeMonitors, app: runStateColumns, peerIp: meshPeers.internalIp })
    .from(uptimeMonitors)
    .leftJoin(apps, eq(apps.id, uptimeMonitors.appId))
    .leftJoin(meshPeers, eq(meshPeers.id, uptimeMonitors.meshPeerId))
    .where(eq(uptimeMonitors.enabled, true));

  // A stopped or missing app is expected to be down. Vantage points sharing a monitor take turns, so this one runs it every interval x N.
  const watchers = await externalWatchers();
  const domainsOn = isFeatureEnabled("domain-monitoring");
  const due = rows.filter(({ monitor, app }) => {
    if (monitor.appId && appNotRunning(app)) return false;
    if (!domainsOn && monitor.source === "auto" && monitor.domainId) return false;
    const slot = staggerOf(monitor.id, monitor.intervalSec, sharing(watchers, monitor.id), LOCAL_VANTAGE_ID);
    return isDueAt(slot.periodSec * 1000, slot.offsetMs, lastRun.get(monitor.id), now);
  });
  if (due.length === 0) return 0;

  const deps = { strict: await checkDeps("strict"), operator: await checkDeps("operator") };
  const fresh: CheckResult[] = [];
  await pool(due, CONCURRENCY, async ({ monitor, peerIp }) => {
    lastRun.set(monitor.id, now);
    try {
      // The tunnel monitor of a peer connects to that peer's console and nowhere else.
      if (monitor.peerRole === "link") {
        const address = tunnelAddress(peerIp);
        if (!address) return;
        fresh.push(await runCheck({ id: monitor.id, check: monitor.check }, local.id, "local", { now: clock, ...tunnelDeps(address, [Number(CONSOLE_PORT)]) }));
        return;
      }
      const { fetch, guard } = deps[monitor.peerRole === "public" ? "strict" : levelOf(monitor)];
      const check = monitor.check.type === "http" && monitor.headersEncrypted ? { ...monitor.check, headers: openHeaders(monitor.headersEncrypted, monitor) } : monitor.check;
      fresh.push(await runCheck({ id: monitor.id, check }, local.id, "local", { now: clock, fetch, guard }));
    } catch (err) {
      log.warn(`Check for ${monitor.id} threw:`, err);
    }
  });

  if (fresh.length > 0) {
    await db.insert(uptimeResults).values(
      fresh.map((r) => ({
        monitorId: r.monitorId,
        vantageId: r.vantageId,
        path: r.path,
        at: new Date(r.at),
        ok: r.ok,
        latencyMs: r.latencyMs,
        status: r.status ?? null,
        error: r.error ?? null,
        certDaysLeft: r.certDaysLeft ?? null,
        cache: r.cache ?? null,
        bytes: r.bytes ?? null,
      })),
    );
    await syncAlerts(due.map((d) => d.monitor).filter((m) => fresh.some((r) => r.monitorId === m.id)), now);
  }
  return fresh.length;
}

/** Re-evaluates the monitors with these ids, such as after a peer delivers results. */
export async function syncAlertsFor(ids: string[], now = Date.now()): Promise<void> {
  if (ids.length === 0) return;
  await syncAlerts(await db.select().from(uptimeMonitors).where(and(eq(uptimeMonitors.enabled, true), inArray(uptimeMonitors.id, ids))), now);
}

async function syncAlerts(monitors: (typeof uptimeMonitors.$inferSelect)[], now: number, reportingPeers: string[] = []): Promise<void> {
  if (monitors.length === 0 && reportingPeers.length === 0) return;
  const vantages = await listVantagePoints();
  const recent = await db
    .select()
    .from(uptimeResults)
    .where(and(inArray(uptimeResults.monitorId, monitors.map((m) => m.id)), gte(uptimeResults.at, new Date(now - RECENT_MS))));
  const results: CheckResult[] = recent.map(toResult);
  const operator = monitors.some((m) => !m.organizationId) ? await adminOrgIds() : [];
  const watchers = await externalWatchers();

  // A peer's monitors are read together, so one verdict raises one alert.
  const peerIds = [...new Set([...monitors.map((m) => m.meshPeerId).filter((id): id is string => !!id), ...reportingPeers])];
  if (peerIds.length > 0) {
    const silent = (row: typeof uptimeMonitors.$inferSelect) => row.muted || inMaintenance({ maintenance: row.maintenance }, now);
    await syncPeerAlerts(peerIds, now, silent).catch((err) => log.error("Peer alert sync failed:", err));
  }

  const impaired = await loadImpaired(now);
  for (const m of monitors) {
    if (m.meshPeerId) continue;
    // Waiting on an answer: no alerts, and none opened from the checks that ran meanwhile.
    if (m.reviewStatus !== null && m.reviewAnswer === null) continue;
    try {
      const silent = m.muted || inMaintenance({ maintenance: m.maintenance }, now);
      if (silent) continue;
      const evaluation = evaluate({
        vantages,
        results: results.filter((r) => r.monitorId === m.id),
        now,
        intervalSec: effectiveIntervalSec(m.intervalSec, sharing(watchers, m.id).length),
        impaired,
      });
      const observation = evaluation.state === "unknown" ? null : { state: evaluation.state, key: `${evaluation.state}|${JSON.stringify(evaluation.reading ?? null)}` };
      const before = damping.get(m.id) ?? newMemory();
      const { memory, actions } = stepDamping(before, observation, now);
      damping.set(m.id, memory);
      if (actions.length === 0) continue;

      const title = incidentTitle(m.name, evaluation.state, evaluation.reading);
      const audience = m.organizationId ? [m.organizationId] : operator;
      const outage = {
        about: m.id,
        name: m.name,
        title,
        orgIds: audience,
        appId: m.appId ?? undefined,
        severity: evaluation.state === "degraded" ? ("warning" as const) : ("critical" as const),
      };
      const say = (kind: Notice["kind"], noticeTitle: string, detail: string) =>
        queueNotice({ at: now, kind, audience: audience.join(","), monitorId: m.id, name: m.name, title: noticeTitle, detail });

      for (const action of actions) {
        if (action.kind === "open") {
          // A new state or reading replaces the open incident, so its title is right.
          if (before.announced) await resolveUptimeIncident(outage, "", { notify: false });
          const detail = evaluation.reading
            ? `${title}. ${readingDetail(evaluation.reading)}`
            : `${m.name} isn't responding${evaluation.localOnly ? " from this instance" : ""}.`;
          await openUptimeIncident(outage, detail, { notify: false });
          if (action.notify) say("down", title, detail);
        } else if (action.kind === "resolve") {
          const wasOpen = await resolveUptimeIncident(outage, "", { notify: false });
          if (action.notify || (action.stale && wasOpen)) say("recovered", `${m.name} is responding again`, `${m.name} is responding again.`);
        } else if (action.kind === "flapping") {
          say("flapping", `${m.name} is flapping`, `${m.name} changed state more than 3 times in 30 minutes. Notices pause until it has been stable for 15 minutes.`);
        } else {
          const word = action.state === "up" ? "up" : action.state === "down" ? "down" : "degraded";
          say("settled", `${m.name} settled: ${word}`, `${m.name} has been stable for 15 minutes and is ${word}.`);
        }
      }
    } catch (err) {
      log.error(`Alert sync for ${m.id} failed:`, err);
    }
  }
}

type BucketRow = { monitorId: string; start: Date; minutesUp: number; minutesDown: number; minutesUnknown: number; medianLatencyMs: number | null };

const toRow = (monitorId: string, b: Bucket): BucketRow => ({
  monitorId,
  start: new Date(b.start),
  minutesUp: b.minutesUp,
  minutesDown: b.minutesDown,
  minutesUnknown: b.minutesUnknown,
  medianLatencyMs: b.medianLatencyMs,
});

/** Recomputes the current and previous hour for each monitor, signs them, and folds the hours into their days. */
export async function rollup(now = Date.now()): Promise<void> {
  const monitors = await db
    .select({ id: uptimeMonitors.id, intervalSec: uptimeMonitors.intervalSec, reviewStatus: uptimeMonitors.reviewStatus, reviewAnswer: uptimeMonitors.reviewAnswer })
    .from(uptimeMonitors);
  if (monitors.length === 0) return;
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const from = thisHour - HOUR_MS;
  const [vantages, key, raw, watchers, impaired] = await Promise.all([
    listVantagePoints(),
    localSigningKey(),
    db
      .select()
      .from(uptimeResults)
      .where(and(inArray(uptimeResults.monitorId, monitors.map((m) => m.id)), gte(uptimeResults.at, new Date(from - 10 * 60_000)))),
    externalWatchers(),
    loadImpaired(now),
  ]);
  const byMonitor = new Map<string, CheckResult[]>();
  for (const r of raw) {
    const list = byMonitor.get(r.monitorId) ?? [];
    list.push(toResult(r));
    byMonitor.set(r.monitorId, list);
  }

  const signedAt = new Date(now);
  for (const m of monitors) {
    const buckets = summarize({ results: m.reviewStatus !== null && m.reviewAnswer === null ? [] : markImpaired(byMonitor.get(m.id) ?? [], impaired), vantages, intervalSec: effectiveIntervalSec(m.intervalSec, sharing(watchers, m.id).length), from, to: now + 1, bucketMs: HOUR_MS });
    for (const b of buckets) {
      if (b.minutesUp + b.minutesDown === 0 && b.minutesUnknown === 0) continue;
      const signed = signRecord(hourlySummary(LOCAL_VANTAGE_ID, m.id, b, now), key);
      const row = { ...toRow(m.id, b), record: signed.payload, sig: signed.sig, signedAt };
      await db
        .insert(uptimeHourly)
        .values(row)
        .onConflictDoUpdate({
          target: [uptimeHourly.monitorId, uptimeHourly.start],
          set: { minutesUp: row.minutesUp, minutesDown: row.minutesDown, minutesUnknown: row.minutesUnknown, medianLatencyMs: row.medianLatencyMs, record: row.record, sig: row.sig, signedAt },
        });
    }
    await rollDays(m.id, [...new Set(buckets.map((b) => Math.floor(b.start / DAY_MS) * DAY_MS))]);
  }
}

async function rollDays(monitorId: string, days: number[]): Promise<void> {
  for (const day of days) {
    const hours = await db
      .select()
      .from(uptimeHourly)
      .where(and(eq(uptimeHourly.monitorId, monitorId), gte(uptimeHourly.start, new Date(day)), lt(uptimeHourly.start, new Date(day + DAY_MS))));
    if (hours.length === 0) continue;
    const b = combine(
      hours.map((h) => ({ start: h.start.getTime(), minutesUp: h.minutesUp, minutesDown: h.minutesDown, minutesUnknown: h.minutesUnknown, uptimePct: null, medianLatencyMs: h.medianLatencyMs })),
      day,
    );
    const row = toRow(monitorId, b);
    await db
      .insert(uptimeDaily)
      .values(row)
      .onConflictDoUpdate({
        target: [uptimeDaily.monitorId, uptimeDaily.start],
        set: { minutesUp: row.minutesUp, minutesDown: row.minutesDown, minutesUnknown: row.minutesUnknown, medianLatencyMs: row.medianLatencyMs },
      });
  }
}

/** Raw results past 14 days and hourly rollups past a year. Daily rollups stay. */
export async function prune(now = Date.now()): Promise<void> {
  await db.delete(uptimeResults).where(lt(uptimeResults.at, new Date(now - RAW_RETENTION_MS)));
  await db.delete(uptimeHourly).where(lt(uptimeHourly.start, new Date(now - HOURLY_RETENTION_MS)));
  await db.delete(uptimeRecords).where(and(eq(uptimeRecords.kind, "results"), lt(uptimeRecords.issuedAt, new Date(now - RAW_RETENTION_MS))));
  await db.delete(uptimeRecords).where(and(eq(uptimeRecords.kind, "hourly"), lt(uptimeRecords.issuedAt, new Date(now - HOURLY_RETENTION_MS))));
  await pruneProbes(now, RAW_RETENTION_MS, HOURLY_RETENTION_MS);
}

/** Re-evaluates every enabled monitor, so a vantage point that went quiet stops counting. */
export async function syncAllAlerts(now = Date.now()): Promise<void> {
  // Peers that report to us are judged even when no monitor of ours watches them.
  const reporting = (await db.select({ peerId: uptimePeerReports.peerId }).from(uptimePeerReports)).map((r) => r.peerId);
  await syncAlerts(await db.select().from(uptimeMonitors).where(eq(uptimeMonitors.enabled, true)), now, reporting).catch((err) => log.error("Alert re-evaluation failed:", err));
}

/** One pass of the worker loop. */
export async function tickUptime(now = Date.now()): Promise<void> {
  await syncIfDue(now);
  await runDueChecks(now);
  // In the background, so spaced-out probing never delays the checks.
  void runHealthDetection(now).catch((err) => log.error("Health detection failed:", err));
  await tickProber(now).catch((err) => log.error("Probing linked instances failed:", err));
  await pushReports(now).catch((err) => log.error("Reporting to linked instances failed:", err));
  if (now - lastReeval >= 30_000) {
    lastReeval = now;
    // Reports first: a peer that no longer lets us watch it is dropped before its silence reads as an outage.
    await syncReportAlerts(now).catch((err) => log.error("Report alert sync failed:", err));
    await syncAllAlerts(now);
  }
  await flushNotices(now).catch((err) => log.error("Sending uptime notices failed:", err));
  if (now - lastRollup >= 60_000) {
    lastRollup = now;
    await rollup(now);
  }
  if (now - lastPrune >= HOUR_MS) {
    lastPrune = now;
    await prune(now);
  }
}

let lastSync = 0;
async function syncIfDue(now: number): Promise<void> {
  if (now - lastSync < 60_000) return;
  lastSync = now;
  const { added, removed } = await syncAutoMonitors();
  if (added || removed) log.info(`Auto monitors: ${added} added, ${removed} removed`);
}
