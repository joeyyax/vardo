// The probing side of a link: fetches a peer's watch list, checks its monitors and delivers signed results. Public monitors are checked over the
// internet; private ones over the mesh, connecting only to that peer's tunnel address.

import { and, asc, eq, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers, uptimeProbeResults, uptimeProbeSummaries, uptimeVantages, uptimeWatchEntries } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { MeshClientError, meshSignedPost } from "@/lib/mesh/client";
import {
  HOUR_MS,
  isDueAt,
  hourlySummary,
  resultBatch,
  signRecord,
  summarize,
  verifyRecord,
  type CheckPath,
  type CheckResult,
  type SignedRecord,
  type VantagePoint,
  type WatchEntry,
} from "./core";
import { localIdentity } from "./identity";
import {
  MAX_WATCH_ENTRIES,
  RESULTS_PATH,
  WATCH_PATH,
  resultsResponseSchema,
  watchEntrySchema,
  watchResponseSchema,
} from "./link";
import { tunnelAddress } from "./mesh-path";
import { probeEntry, type ProbeDeps } from "./probe-entry";
import { checkDeps } from "./outbound";
import { localSigningKey } from "./vantage";

const log = logger.child("uptime-probe");

export const WATCH_REFRESH_MS = 5 * 60_000;
export const DELIVER_EVERY_MS = 60_000;
const PUSH_BATCH = 500;
const CONCURRENCY = 10;
const WATCH_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 30_000;

const lastFetch = new Map<string, number>();
const lastDelivery = new Map<string, number>();
const lastProbe = new Map<string, number>();
let seeded = false;

export type { ProbeDeps };

type LinkedPeer = { id: string; name: string };

async function checkingPeers(): Promise<LinkedPeer[]> {
  return db.query.meshPeers.findMany({
    where: and(eq(meshPeers.connectionType, "direct"), eq(meshPeers.uptimeChecksPeer, true)),
    columns: { id: true, name: true },
  });
}

/** Replaces a peer's stored watch list with the one it just served. */
async function storeWatch(peerId: string, entries: WatchEntry[], now: number): Promise<void> {
  const at = new Date(now);
  await db.transaction(async (tx) => {
    const ids = entries.map((e) => e.monitorId);
    if (ids.length === 0) await tx.delete(uptimeWatchEntries).where(eq(uptimeWatchEntries.peerId, peerId));
    else await tx.delete(uptimeWatchEntries).where(and(eq(uptimeWatchEntries.peerId, peerId), notInArray(uptimeWatchEntries.monitorId, ids)));
    for (const e of entries) {
      await tx
        .insert(uptimeWatchEntries)
        .values({ peerId, monitorId: e.monitorId, check: e.check, intervalSec: e.intervalSec, path: e.path ?? "public", periodSec: e.periodSec ?? null, offsetMs: e.offsetMs ?? null, fetchedAt: at })
        .onConflictDoUpdate({
          target: [uptimeWatchEntries.peerId, uptimeWatchEntries.monitorId],
          set: { check: e.check, intervalSec: e.intervalSec, path: e.path ?? "public", periodSec: e.periodSec ?? null, offsetMs: e.offsetMs ?? null, fetchedAt: at },
        });
    }
  });
}

/** Fetches one peer's watch list and verifies its signature. Returns the entries, or null when the peer refuses or sends junk. */
async function fetchWatch(peer: LinkedPeer): Promise<WatchEntry[] | null> {
  const identity = await localIdentity();
  let data: unknown;
  try {
    ({ data } = await meshSignedPost(peer.id, WATCH_PATH, { vantage: identity }, { timeoutMs: WATCH_TIMEOUT_MS, probeMs: 2000 }));
  } catch (err) {
    if (err instanceof MeshClientError && err.statusCode === 403) return null;
    throw err;
  }
  const parsed = watchResponseSchema.safeParse(data);
  if (!parsed.success) throw new Error("Malformed watch list");

  // A peer that already checks us announced a key; the same peer must keep using it.
  const known = await db.query.uptimeVantages.findFirst({ where: eq(uptimeVantages.meshPeerId, peer.id), columns: { publicKey: true } });
  if (known && known.publicKey !== parsed.data.vantage.publicKey) throw new Error("Vantage key changed");

  const payload = verifyRecord(parsed.data.watch, parsed.data.vantage.publicKey);
  if (!payload || payload.kind !== "watch" || payload.vantageId !== parsed.data.vantage.id) throw new Error("Bad watch list signature");

  const entries: WatchEntry[] = [];
  for (const raw of payload.monitors.slice(0, MAX_WATCH_ENTRIES)) {
    const entry = watchEntrySchema.safeParse(raw);
    if (entry.success) entries.push(entry.data as WatchEntry);
  }
  return entries;
}

/** Refreshes each checking peer's watch list every five minutes and clears the lists of peers switched off. */
export async function refreshWatchLists(now = Date.now(), force = false): Promise<void> {
  const peers = await checkingPeers();
  const active = new Set(peers.map((p) => p.id));
  const stale = await db.selectDistinct({ peerId: uptimeWatchEntries.peerId }).from(uptimeWatchEntries);
  for (const s of stale) if (!active.has(s.peerId)) await db.delete(uptimeWatchEntries).where(eq(uptimeWatchEntries.peerId, s.peerId));

  const due = peers.filter((p) => force || now - (lastFetch.get(p.id) ?? 0) >= WATCH_REFRESH_MS);
  await Promise.all(
    due.map(async (peer) => {
      lastFetch.set(peer.id, now);
      try {
        const entries = await fetchWatch(peer);
        await storeWatch(peer.id, entries ?? [], now);
      } catch (err) {
        log.warn(`Watch list from ${peer.name} unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );
}

async function seedLastProbe(): Promise<void> {
  if (seeded) return;
  seeded = true;
  const rows = await db
    .select({ peerId: uptimeProbeResults.peerId, monitorId: uptimeProbeResults.monitorId, at: sql<Date>`max(${uptimeProbeResults.at})` })
    .from(uptimeProbeResults)
    .where(gte(uptimeProbeResults.at, new Date(Date.now() - 10 * 60_000)))
    .groupBy(uptimeProbeResults.peerId, uptimeProbeResults.monitorId);
  for (const r of rows) lastProbe.set(`${r.peerId}:${r.monitorId}`, new Date(r.at).getTime());
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

/** Runs the peers' checks that are due. */
export async function probeDue(now = Date.now(), deps: ProbeDeps = {}): Promise<number> {
  await seedLastProbe();
  const rows = await db
    .select({ entry: uptimeWatchEntries, internalIp: meshPeers.internalIp })
    .from(uptimeWatchEntries)
    .innerJoin(meshPeers, eq(meshPeers.id, uptimeWatchEntries.peerId))
    .where(eq(meshPeers.uptimeChecksPeer, true));
  // A schedule from the owner staggers this vantage point among those sharing the monitor; without one it checks every interval.
  const due = rows.filter(({ entry: e }) => {
    const last = lastProbe.get(`${e.peerId}:${e.monitorId}`);
    if (e.periodSec !== null && e.offsetMs !== null) return isDueAt(e.periodSec * 1000, e.offsetMs, last, now);
    return now - (last ?? 0) >= e.intervalSec * 1000 - 1000;
  });
  if (due.length === 0) return 0;

  const identity = await localIdentity();
  const strict = await checkDeps("strict");
  const fresh: { peerId: string; result: CheckResult }[] = [];
  await pool(due, CONCURRENCY, async ({ entry: e, internalIp }) => {
    lastProbe.set(`${e.peerId}:${e.monitorId}`, now);
    try {
      const result = await probeEntry(e, { vantageId: identity.id, peerAddress: tunnelAddress(internalIp), strict, deps });
      fresh.push({ peerId: e.peerId, result });
    } catch (err) {
      log.warn(`Probe of ${e.monitorId} threw:`, err);
    }
  });

  if (fresh.length > 0) {
    await db.insert(uptimeProbeResults).values(
      fresh.map(({ peerId, result: r }) => ({
        peerId,
        monitorId: r.monitorId,
        path: r.path,
        at: new Date(r.at),
        ok: r.ok,
        latencyMs: r.latencyMs,
        status: r.status ?? null,
        error: r.error ?? null,
        certDaysLeft: r.certDaysLeft ?? null,
      })),
    );
  }
  return fresh.length;
}

/** Signs the finished hours of each watched monitor, once. */
export async function signSummaries(now = Date.now()): Promise<void> {
  const entries = await db.select().from(uptimeWatchEntries);
  if (entries.length === 0) return;
  const identity = await localIdentity();
  const key = await localSigningKey();
  const self: VantagePoint = { id: identity.id, name: identity.name, kind: "external" };
  const thisHour = Math.floor(now / HOUR_MS) * HOUR_MS;

  for (const hour of [thisHour - 2 * HOUR_MS, thisHour - HOUR_MS]) {
    for (const e of entries) {
      const exists = await db.query.uptimeProbeSummaries.findFirst({
        where: and(eq(uptimeProbeSummaries.peerId, e.peerId), eq(uptimeProbeSummaries.monitorId, e.monitorId), eq(uptimeProbeSummaries.start, new Date(hour))),
        columns: { monitorId: true },
      });
      if (exists) continue;
      const rows = await db
        .select()
        .from(uptimeProbeResults)
        .where(
          and(
            eq(uptimeProbeResults.peerId, e.peerId),
            eq(uptimeProbeResults.monitorId, e.monitorId),
            gte(uptimeProbeResults.at, new Date(hour - 10 * 60_000)),
            lt(uptimeProbeResults.at, new Date(hour + HOUR_MS)),
          ),
        )
        .orderBy(asc(uptimeProbeResults.at));
      if (!rows.some((r) => r.at.getTime() >= hour)) continue;
      const results: CheckResult[] = rows.map((r) => ({
        monitorId: r.monitorId,
        vantageId: identity.id,
        path: r.path as CheckPath,
        at: r.at.getTime(),
        ok: r.ok,
        latencyMs: r.latencyMs,
        ...(r.error ? { error: r.error as CheckResult["error"] } : {}),
      }));
      const [bucket] = summarize({ results, vantages: [self], intervalSec: e.periodSec ?? e.intervalSec, from: hour, to: hour + HOUR_MS, bucketMs: HOUR_MS });
      if (!bucket) continue;
      const signed = signRecord(hourlySummary(identity.id, e.monitorId, bucket, now), key);
      await db
        .insert(uptimeProbeSummaries)
        .values({ peerId: e.peerId, monitorId: e.monitorId, start: new Date(hour), record: signed.payload, sig: signed.sig })
        .onConflictDoNothing();
    }
  }
}

/** Pushes the undelivered results and summaries to one peer, signed. */
async function pushTo(peer: LinkedPeer, now: number): Promise<void> {
  const watched = new Set(
    (await db.select({ id: uptimeWatchEntries.monitorId }).from(uptimeWatchEntries).where(eq(uptimeWatchEntries.peerId, peer.id))).map((r) => r.id),
  );
  const pending = await db
    .select()
    .from(uptimeProbeResults)
    .where(and(eq(uptimeProbeResults.peerId, peer.id), isNull(uptimeProbeResults.deliveredAt)))
    .orderBy(asc(uptimeProbeResults.at))
    .limit(PUSH_BATCH);

  // Results for monitors the peer no longer lists would be refused; they stay in our copy.
  const dropped = pending.filter((r) => !watched.has(r.monitorId)).map((r) => r.id);
  if (dropped.length > 0) await db.update(uptimeProbeResults).set({ deliveredAt: new Date(now) }).where(inArray(uptimeProbeResults.id, dropped));
  const sendable = pending.filter((r) => watched.has(r.monitorId));

  const summaries = (
    await db
      .select()
      .from(uptimeProbeSummaries)
      .where(and(eq(uptimeProbeSummaries.peerId, peer.id), isNull(uptimeProbeSummaries.sentAt)))
      .limit(100)
  ).filter((s) => watched.has(s.monitorId));

  if (sendable.length === 0 && summaries.length === 0) return;

  const identity = await localIdentity();
  const records: SignedRecord[] = [];
  if (sendable.length > 0) {
    const results: CheckResult[] = sendable.map((r) => ({
      monitorId: r.monitorId,
      vantageId: identity.id,
      path: r.path as CheckPath,
      at: r.at.getTime(),
      ok: r.ok,
      latencyMs: r.latencyMs,
      ...(r.status !== null ? { status: r.status } : {}),
      ...(r.error ? { error: r.error as CheckResult["error"] } : {}),
      ...(r.certDaysLeft !== null ? { certDaysLeft: r.certDaysLeft } : {}),
    }));
    records.push(signRecord(resultBatch(identity.id, results, now), await localSigningKey()));
  }
  for (const s of summaries) records.push({ payload: s.record, sig: s.sig });

  const { data } = await meshSignedPost(peer.id, RESULTS_PATH, { records }, { timeoutMs: PUSH_TIMEOUT_MS, probeMs: 2000 });
  const outcome = resultsResponseSchema.safeParse(data);
  if (outcome.success && outcome.data.rejected.length > 0) log.warn(`${peer.name} refused ${outcome.data.rejected.length} record(s): ${outcome.data.rejected[0].reason}`);

  const at = new Date(now);
  if (sendable.length > 0) await db.update(uptimeProbeResults).set({ deliveredAt: at }).where(inArray(uptimeProbeResults.id, sendable.map((r) => r.id)));
  for (const s of summaries) {
    await db
      .update(uptimeProbeSummaries)
      .set({ sentAt: at })
      .where(and(eq(uptimeProbeSummaries.peerId, s.peerId), eq(uptimeProbeSummaries.monitorId, s.monitorId), eq(uptimeProbeSummaries.start, s.start)));
  }
  if (sendable.length === PUSH_BATCH) lastDelivery.delete(peer.id);
}

/** About once a minute per peer, delivers what's waiting. */
export async function deliverResults(now = Date.now(), force = false): Promise<void> {
  const peers = await checkingPeers();
  await Promise.all(
    peers
      .filter((p) => force || now - (lastDelivery.get(p.id) ?? 0) >= DELIVER_EVERY_MS - 1000)
      .map(async (peer) => {
        lastDelivery.set(peer.id, now);
        try {
          await pushTo(peer, now);
        } catch (err) {
          log.warn(`Delivery to ${peer.name} failed: ${err instanceof Error ? err.message : err}`);
        }
      }),
  );
}

/** One worker pass of the probing side. */
export async function tickProber(now = Date.now(), deps: ProbeDeps = {}): Promise<void> {
  await refreshWatchLists(now);
  await probeDue(now, deps);
  await signSummaries(now);
  await deliverResults(now);
}

/** Drops probe copies past retention: raw results after 14 days, summaries after a year. */
export async function pruneProbes(now: number, rawMs: number, hourlyMs: number): Promise<void> {
  await db.delete(uptimeProbeResults).where(lt(uptimeProbeResults.at, new Date(now - rawMs)));
  await db.delete(uptimeProbeSummaries).where(lt(uptimeProbeSummaries.start, new Date(now - hourlyMs)));
}
