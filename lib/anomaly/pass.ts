// One anomaly pass, run from the alert pass: samples, learns, judges and probes, then hands back observations.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/lib/db";
import { apps, notificationSends, organizations } from "@/lib/db/schema";
import type { AlertItem } from "@/lib/bus/events";
import { stackedName } from "@/lib/email/format";
import { logger } from "@/lib/logger";
import { groupMetricsByApp } from "@/lib/metrics/app-match";
import { getLatestSnapshot } from "@/lib/metrics/broadcast";
import type { ContainerMetrics } from "@/lib/metrics/types";
import { settleAlerts, type Observation } from "@/lib/notifications/observations";
import type { AlertType } from "@/lib/notifications/registry";
import { getInstanceTimeZone, resolveTimeZone } from "@/lib/time-zone-settings";
import { BASELINE_WINDOW_MS, WARMUP_MS, computeBaseline, peakOf, utcOffset, zoneOffset, type Baseline, type ZoneOffset } from "./baseline";
import { AnomalyEngine, type FlushedSample } from "./engine";
import { anomalyItem, newPortItem, newProcessItem, type AppRef, type Finding } from "./items";
import { appPorts, probeContainer } from "./probe";
import { activeFindings, reconcileSeen, type SeenEntry, type TopProcess } from "./security";
import { SIGNAL_KEYS, isSensitivity, type Sensitivity, type SignalKey } from "./signals";
import { appendSample, forgetSeen, resetPidsSamples, learningSince, readSamples, readSeen, writeSeen, type SeenKind, type Series } from "./store";
import { activityWindows, markActivity, quietApps, recentWorkWindows } from "./suppress";
import { AppRateTracker, type AppReading } from "./tracker";

const log = logger.child("anomaly");

export const ANOMALY_ALERT_TYPES: AlertType[] = ["app.anomaly", "app.new-port", "app.new-process"];

const SNAPSHOT_STALE_MS = 3 * 60_000;
const BASELINE_TTL_MS = 60 * 60_000;
const BASELINE_REFRESH_PER_PASS = 40;
const PROBE_EVERY_MS = 10 * 60_000;
/** A firing app's processes are re-read this often for the email. */
const PROBE_FIRING_MS = 5 * 60_000;
const PROBES_PER_PASS = 4;
const CONTAINERS_PER_PROBE = 5;
/** A new process or port alert holds this long. */
export const FINDING_HOLD_MS = 60 * 60_000;
/** An open alert holds this long through a gap in judgment, past RESOLVE_MS and several stale snapshots. */
export const GAP_HOLD_MS = 15 * 60_000;

type State = {
  engine: AnomalyEngine;
  tracker: AppRateTracker;
  baselines: Map<string, { baseline: Baseline | null; peak: number; at: number }>;
  probedAt: Map<string, number>;
  top: Map<string, { at: number; processes: TopProcess[] }>;
  seen: Map<string, Record<SeenKind, Map<string, SeenEntry>>>;
  /** Per app: the last pass that judged it, was quiet, or first found it unjudgeable. */
  coveredAt: Map<string, number>;
  lastSnapshotAt: number;
  pidsReset: boolean;
};

const globalForAnomaly = globalThis as unknown as { __vardo_anomaly?: State };
const state: State = (globalForAnomaly.__vardo_anomaly ??= {
  engine: new AnomalyEngine(),
  tracker: new AppRateTracker(),
  baselines: new Map(),
  probedAt: new Map(),
  top: new Map(),
  seen: new Map(),
  coveredAt: new Map(),
  lastSnapshotAt: 0,
  pidsReset: false,
});

/** Every pids sample before collector process counts: cAdvisor reported 0 and the collector reported threads. */
export const PIDS_RELEARN_SINCE = 0;

type WatchedApp = AppRef & {
  organizationId: string;
  parentAppId: string | null;
  enabled: boolean;
  metrics: ContainerMetrics[];
};

/** Leaf apps (a stack's services, not the stack) with their opt-out folded in from the stack. */
async function watchedApps(snapshot: ContainerMetrics[]): Promise<WatchedApp[]> {
  const stacks = alias(apps, "stacks");
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      displayName: apps.displayName,
      status: apps.status,
      parentAppId: apps.parentAppId,
      composeService: apps.composeService,
      containerName: apps.containerName,
      importedContainerId: apps.importedContainerId,
      organizationId: apps.organizationId,
      anomalyAlerts: apps.anomalyAlerts,
      stack: stacks.displayName,
      stackAnomalyAlerts: stacks.anomalyAlerts,
    })
    .from(apps)
    .leftJoin(stacks, eq(stacks.id, apps.parentAppId))
    .where(eq(apps.status, "active"));
  const parents = new Set(rows.flatMap((r) => (r.parentAppId ? [r.parentAppId] : [])));
  const leaves = rows.filter((r) => !parents.has(r.id));
  const grouped = groupMetricsByApp(leaves, snapshot);
  return leaves.map((r) => ({
    id: r.id,
    name: stackedName(r.displayName, r.stack),
    organizationId: r.organizationId,
    parentAppId: r.parentAppId,
    enabled: r.anomalyAlerts && r.stackAnomalyAlerts !== false,
    metrics: grouped.get(r.id) ?? [],
  }));
}

async function orgSettings(): Promise<Map<string, { sensitivity: Sensitivity; offset: ZoneOffset }>> {
  const instance = await getInstanceTimeZone();
  const rows = await db.select({ id: organizations.id, timeZone: organizations.timeZone, sensitivity: organizations.anomalySensitivity }).from(organizations);
  return new Map(
    rows.map((r) => [r.id, { sensitivity: isSensitivity(r.sensitivity) ? r.sensitivity : "normal", offset: zoneOffset(resolveTimeZone(r.timeZone, instance)) }]),
  );
}

type Learned = {
  baselines: Partial<Record<SignalKey, Baseline | null>>;
  peaks: Partial<Record<SignalKey, number>>;
};

/** Cached baselines and peaks, refreshing at most a budget per pass. */
async function baselinesFor(appId: string, offset: ZoneOffset, now: number, budget: { left: number }): Promise<Learned> {
  const out: Learned = { baselines: {}, peaks: {} };
  for (const signal of SIGNAL_KEYS) {
    const k = `${appId}:${signal}`;
    const cached = state.baselines.get(k);
    if (cached && now - cached.at < BASELINE_TTL_MS) {
      out.baselines[signal] = cached.baseline;
      out.peaks[signal] = cached.peak;
      continue;
    }
    if (budget.left <= 0) {
      out.baselines[signal] = cached?.baseline ?? null;
      out.peaks[signal] = cached?.peak ?? 0;
      continue;
    }
    budget.left--;
    const from = now - BASELINE_WINDOW_MS;
    const cutoff = state.engine.peakCutoff(appId, signal, now);
    const samples = await readSamples(appId, signal, from, now);
    const all = await readSamples(appId, signal, from, cutoff, "all");
    const baseline = computeBaseline(samples, now, offset);
    const peak = Math.max(peakOf(samples, from, cutoff), peakOf(all, from, cutoff));
    state.baselines.set(k, { baseline, peak, at: now });
    out.baselines[signal] = baseline;
    out.peaks[signal] = peak;
  }
  return out;
}

async function seenFor(appId: string): Promise<Record<SeenKind, Map<string, SeenEntry>>> {
  const hit = state.seen.get(appId);
  if (hit) return hit;
  const [procs, ports] = await Promise.all([readSeen(appId, "procs"), readSeen(appId, "ports")]);
  const loaded = { procs, ports };
  state.seen.set(appId, loaded);
  return loaded;
}

async function fold(appId: string, kind: SeenKind, current: string[], now: number, learning: boolean): Promise<void> {
  const seen = await seenFor(appId);
  const { set, remove } = reconcileSeen(seen[kind], current, now, learning);
  if (set.size === 0 && remove.length === 0) return;
  for (const [item, entry] of set) seen[kind].set(item, entry);
  for (const item of remove) seen[kind].delete(item);
  await writeSeen(appId, kind, set, remove);
}

async function forget(appId: string, kind: SeenKind): Promise<void> {
  const seen = await seenFor(appId);
  if (seen[kind].size === 0) return;
  seen[kind].clear();
  await forgetSeen(appId, kind);
}

/** Reads processes and ports for one app and folds them into its allow-sets. */
async function probeApp(app: WatchedApp, now: number, quiet: boolean): Promise<void> {
  state.probedAt.set(app.id, now);
  const containers = app.metrics.slice(0, CONTAINERS_PER_PROBE);
  const results = await Promise.allSettled(containers.map((m) => probeContainer(m.containerIdFull || m.containerId)));
  const probes = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (probes.length === 0) return;

  const processes = probes.flatMap((p) => p.processes);
  state.top.set(app.id, { at: now, processes });
  const learning = quiet || now - (await learningSince(app.id, now)) < WARMUP_MS;
  // A container that couldn't be probed would look like it stopped its processes.
  if (probes.length === containers.length) await fold(app.id, "procs", [...new Set(processes.map((p) => p.name))], now, learning);
  const ports = appPorts(probes, containers.length);
  if (ports.action === "fold") await fold(app.id, "ports", ports.ports, now, learning);
  else if (ports.action === "forget") await forget(app.id, "ports");
}

/** Open anomaly alerts, to hold the ones this pass can't judge. */
async function openAlerts(): Promise<{ organizationId: string; type: string; about: string; detail: unknown }[]> {
  return db
    .select({ organizationId: notificationSends.organizationId, type: notificationSends.type, about: notificationSends.about, detail: notificationSends.detail })
    .from(notificationSends)
    .where(and(inArray(notificationSends.type, ANOMALY_ALERT_TYPES), isNull(notificationSends.clearedAt)));
}

function holdObservation(type: AlertType, about: string, detail: unknown): Observation | null {
  const item = detail as AlertItem | null;
  if (!item?.title) return null;
  return { type, about, severity: item.severity, fires: false, item };
}

/** Whether an unjudged app's open alert still holds; marks the gap's start on its first pass. */
function holdsThroughGap(appId: string, now: number, covered: boolean): boolean {
  if (covered || !state.coveredAt.has(appId)) state.coveredAt.set(appId, now);
  return now - (state.coveredAt.get(appId) ?? now) < GAP_HOLD_MS;
}

/** Null when there's no fresh snapshot, so the caller neither fires nor clears anomaly alerts. */
export async function anomalyObservations(now: number): Promise<Map<string, Observation[]> | null> {
  const snapshot = getLatestSnapshot();
  const newest = Math.max(0, ...(snapshot ?? []).map((m) => m.timestamp));
  if (!snapshot || snapshot.length === 0 || now - newest > SNAPSHOT_STALE_MS) return null;
  const fresh = newest !== state.lastSnapshotAt;
  state.lastSnapshotAt = newest;

  if (!state.pidsReset) {
    try {
      await resetPidsSamples(PIDS_RELEARN_SINCE, now);
      state.pidsReset = true;
    } catch (err) {
      log.warn("Pids sample reset failed:", (err as Error).message);
    }
  }

  const [watched, orgs, work, open] = await Promise.all([watchedApps(snapshot), orgSettings(), recentWorkWindows(now), openAlerts()]);
  const byOrg = new Map<string, Observation[]>();
  const add = (orgId: string, o: Observation) => byOrg.set(orgId, [...(byOrg.get(orgId) ?? []), o]);
  const openByAbout = new Map(open.map((o) => [`${o.type}:${o.about}`, o]));

  const enabled = watched.filter((a) => a.enabled);
  for (const app of watched.filter((a) => !a.enabled)) {
    for (const type of ANOMALY_ALERT_TYPES) {
      if (openByAbout.has(`${type}:${app.id}`)) await settleAlerts(app.organizationId, type, [app.id], new Date(now));
    }
  }

  const readings = new Map<string, AppReading>();
  if (fresh) {
    for (const app of enabled) {
      const reading = state.tracker.observe(app.id, app.metrics);
      if (reading.restarted) markActivity(app.id, now);
      if (app.metrics.length > 0) readings.set(app.id, reading);
    }
    state.tracker.prune(snapshot);
  }
  const quiet = quietApps([...work, ...(await activityWindows(now))], now);
  const isQuiet = (app: WatchedApp) => quiet.has(app.id) || (!!app.parentAppId && quiet.has(app.parentAppId));

  const budget = { left: BASELINE_REFRESH_PER_PASS };
  const firing: WatchedApp[] = [];
  const judged = new Map<string, { findings: Finding[]; fires: boolean }>();
  for (const app of enabled) {
    const org = orgs.get(app.organizationId) ?? { sensitivity: "normal" as const, offset: utcOffset };
    const reading = readings.get(app.id);
    if (reading) {
      const all: FlushedSample[] = [];
      const learned = state.engine.record(app.id, reading.values, newest, isQuiet(app), all);
      const write = (s: FlushedSample, series: Series) =>
        appendSample(app.id, s.signal, s.at, s.value, series).catch((err) => log.warn(`Sample write failed for ${app.id}:`, (err as Error).message));
      for (const s of learned) await write(s, "baseline");
      for (const s of all) await write(s, "all");
    }

    const { baselines, peaks } = await baselinesFor(app.id, org.offset, now, budget);
    const evaluation = state.engine.evaluate(app.id, baselines, {
      now,
      sensitivity: org.sensitivity,
      offset: org.offset,
      quiet: isQuiet(app),
      peaks,
    });
    if (evaluation.state === "unknown") {
      const held = openByAbout.get(`app.anomaly:${app.id}`);
      const o = held && holdsThroughGap(app.id, now, isQuiet(app)) && holdObservation("app.anomaly", app.id, held.detail);
      if (o) add(app.organizationId, o);
      continue;
    }
    state.coveredAt.set(app.id, now);
    if (evaluation.findings.length === 0) continue;
    const fires = evaluation.findings.some((f) => f.verdict.fires);
    if (fires) firing.push(app);
    judged.set(app.id, { findings: evaluation.findings, fires });
  }

  // Probes: firing apps first for their top processes, then whoever is due.
  const due = [
    ...firing.filter((a) => now - (state.top.get(a.id)?.at ?? 0) >= PROBE_FIRING_MS),
    ...enabled
      .filter((a) => !firing.includes(a) && a.metrics.length > 0 && now - (state.probedAt.get(a.id) ?? 0) >= PROBE_EVERY_MS)
      .sort((a, b) => (state.probedAt.get(a.id) ?? 0) - (state.probedAt.get(b.id) ?? 0)),
  ].slice(0, PROBES_PER_PASS);
  for (const app of due) {
    try {
      await probeApp(app, now, isQuiet(app));
    } catch (err) {
      log.warn(`Probe failed for ${app.name}:`, (err as Error).message);
    }
  }

  for (const app of enabled) {
    const top = state.top.get(app.id);
    const recentTop = top && now - top.at < PROBE_EVERY_MS * 2 ? top.processes : null;
    const verdict = judged.get(app.id);
    const seen = state.seen.get(app.id);
    if (verdict) {
      const fresh = seen ? activeFindings(seen.procs, now, FINDING_HOLD_MS).map((f) => f.item) : [];
      const item = anomalyItem(app, verdict.findings, recentTop, fresh);
      add(app.organizationId, { type: "app.anomaly", about: app.id, severity: item.severity, fires: verdict.fires, item });
    }

    if (!seen) {
      for (const type of ["app.new-port", "app.new-process"] as const) {
        const held = openByAbout.get(`${type}:${app.id}`);
        const o = held && holdsThroughGap(app.id, now, false) && holdObservation(type, app.id, held.detail);
        if (o) add(app.organizationId, o);
      }
      continue;
    }
    const procs = activeFindings(seen.procs, now, FINDING_HOLD_MS);
    if (procs.length > 0) {
      const item = newProcessItem(app, procs.map((f) => f.item), Math.min(...procs.map((f) => f.flaggedAt)), recentTop);
      add(app.organizationId, { type: "app.new-process", about: app.id, severity: item.severity, fires: true, item });
    }
    const ports = activeFindings(seen.ports, now, FINDING_HOLD_MS);
    if (ports.length > 0) {
      const item = newPortItem(app, ports.map((f) => f.item), Math.min(...ports.map((f) => f.flaggedAt)), recentTop);
      add(app.organizationId, { type: "app.new-port", about: app.id, severity: item.severity, fires: true, item });
    }
  }

  const live = new Set(enabled.map((a) => a.id));
  state.engine.retain(live);
  for (const map of [state.probedAt, state.top, state.seen, state.coveredAt]) for (const id of map.keys()) if (!live.has(id)) map.delete(id);
  for (const k of state.baselines.keys()) if (!live.has(k.slice(0, k.lastIndexOf(":")))) state.baselines.delete(k);
  return byOrg;
}
