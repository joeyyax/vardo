// The owning side of a link: serves a peer our watch list and stores the signed results it sends back, as received.

import { createPublicKey } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, meshPeers, uptimeMonitors, uptimeRecords, uptimeResults, uptimeVantages, type UptimeVantageRow } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { HOUR_MS, signRecord, verifyRecord, watchList, type CheckResult, type WatchEntry } from "./core";
import { checkWatchedBatch } from "./batch";
import { syncAlertsFor } from "./engine";
import { localIdentity } from "./identity";
import { resultsRequestSchema, watchRequestSchema, type VantageIdentity } from "./link";
import { publicEntries, type Resolver } from "./net";
import { localSigningKey } from "./vantage";

const log = logger.child("uptime-link");

export type LinkReply = { status: number; json: unknown };

const reply = (status: number, json: unknown): LinkReply => ({ status, json });


export const externalVantageId = (peerId: string) => `ext_${peerId}`;

/** Every enabled monitor with a public address. Monitors of stopped apps stay out, as they do from local checks. */
export async function buildWatchEntries(resolve?: Resolver): Promise<WatchEntry[]> {
  const rows = await db
    .select({ monitor: uptimeMonitors, appStatus: apps.status })
    .from(uptimeMonitors)
    .leftJoin(apps, eq(apps.id, uptimeMonitors.appId))
    .where(eq(uptimeMonitors.enabled, true));
  const live = rows.filter(({ monitor, appStatus }) => !(monitor.source === "auto" && appStatus === "stopped")).map((r) => r.monitor);
  return publicEntries(live, resolve);
}

function validKey(pem: string): boolean {
  try {
    return createPublicKey(pem).asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

async function vantageFor(peerId: string): Promise<UptimeVantageRow | null> {
  return (await db.query.uptimeVantages.findFirst({ where: eq(uptimeVantages.meshPeerId, peerId) })) ?? null;
}

/** A peer asks for our watch list and tells us who it is. */
export async function serveWatchList(peerId: string, body: unknown, now = Date.now(), resolve?: Resolver): Promise<LinkReply> {
  const peer = await db.query.meshPeers.findFirst({ where: eq(meshPeers.id, peerId), columns: { id: true, name: true, uptimeChecksUs: true } });
  if (!peer || !peer.uptimeChecksUs) return reply(403, { error: "This instance doesn't accept uptime checks from you" });

  const parsed = watchRequestSchema.safeParse(body);
  if (!parsed.success || !validKey(parsed.data.vantage.publicKey)) return reply(400, { error: "Invalid vantage point" });
  const who: VantageIdentity = parsed.data.vantage;

  const entries = await buildWatchEntries(resolve);
  const row = {
    name: who.name,
    location: who.location,
    publicKey: who.publicKey,
    remoteId: who.id,
    watching: entries.map((e) => e.monitorId),
  };
  const id = externalVantageId(peer.id);
  await db
    .insert(uptimeVantages)
    .values({ id, kind: "external", meshPeerId: peer.id, ...row })
    .onConflictDoUpdate({ target: uptimeVantages.id, set: row });

  const identity = await localIdentity();
  return reply(200, { vantage: identity, watch: signRecord(watchList(identity.id, entries, now), await localSigningKey()) });
}

type Rejection = { index: number; reason: string };

/** A peer pushes signed records. Each is checked against the key it announced, then stored untouched. */
export async function receiveRecords(peerId: string, body: unknown, now = Date.now()): Promise<LinkReply> {
  const peer = await db.query.meshPeers.findFirst({ where: eq(meshPeers.id, peerId), columns: { id: true, uptimeChecksUs: true } });
  if (!peer || !peer.uptimeChecksUs) return reply(403, { error: "This instance doesn't accept uptime checks from you" });
  const vantage = await vantageFor(peer.id);
  if (!vantage?.remoteId) return reply(403, { error: "Unknown vantage point" });

  const parsed = resultsRequestSchema.safeParse(body);
  if (!parsed.success) return reply(400, { error: "Invalid records" });

  const watching = new Set(vantage.watching);
  const rejected: Rejection[] = [];
  const touched = new Set<string>();
  let accepted = 0;

  for (const [index, record] of parsed.data.records.entries()) {
    const payload = verifyRecord(record, vantage.publicKey);
    if (!payload) {
      rejected.push({ index, reason: "bad signature" });
      continue;
    }
    if (payload.vantageId !== vantage.remoteId) {
      rejected.push({ index, reason: "wrong vantage point" });
      continue;
    }
    const issuedAt = new Date(payload.issuedAt);
    if (payload.kind === "results") {
      const bad = checkWatchedBatch(payload.results, vantage.remoteId, watching, now);
      if (bad) {
        rejected.push({ index, reason: bad });
        continue;
      }
      const stored = await storeRecord(vantage.id, "results", null, issuedAt, record, payload.results);
      if (stored) payload.results.forEach((r) => touched.add(r.monitorId));
      accepted++;
    } else if (payload.kind === "hourly") {
      if (!watching.has(payload.monitorId)) {
        rejected.push({ index, reason: "monitor not watched" });
        continue;
      }
      if (payload.bucket.start % HOUR_MS !== 0) {
        rejected.push({ index, reason: "bucket off the hour" });
        continue;
      }
      await storeRecord(vantage.id, "hourly", payload.monitorId, issuedAt, record, []);
      accepted++;
    } else {
      rejected.push({ index, reason: "unexpected record" });
    }
  }

  if (rejected.length > 0) log.warn(`Refused ${rejected.length} uptime record(s) from ${vantage.name}: ${rejected[0].reason}`);
  if (touched.size > 0) await syncAlertsFor([...touched], now).catch((err) => log.error("Alert sync after delivery failed:", err));
  return reply(200, { accepted, rejected });
}

/** Stores one verified record and the results it carries. False when the same record already arrived. */
async function storeRecord(
  vantageId: string,
  kind: "results" | "hourly",
  monitorId: string | null,
  issuedAt: Date,
  record: { payload: string; sig: string },
  results: CheckResult[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const seen = await tx
      .select({ id: uptimeRecords.id })
      .from(uptimeRecords)
      .where(and(eq(uptimeRecords.vantageId, vantageId), eq(uptimeRecords.kind, kind), eq(uptimeRecords.issuedAt, issuedAt), eq(uptimeRecords.sig, record.sig)))
      .limit(1);
    if (seen.length > 0) return false;
    const [row] = await tx
      .insert(uptimeRecords)
      .values({ vantageId, kind, monitorId, issuedAt, payload: record.payload, sig: record.sig })
      .returning({ id: uptimeRecords.id });
    if (results.length > 0) {
      await tx
        .insert(uptimeResults)
        .values(
          results.map((r) => ({
            monitorId: r.monitorId,
            vantageId,
            at: new Date(r.at),
            ok: r.ok,
            latencyMs: r.latencyMs,
            status: r.status ?? null,
            error: r.error ?? null,
            certDaysLeft: r.certDaysLeft ?? null,
            recordId: row.id,
          })),
        )
        .onConflictDoNothing();
    }
    return true;
  });
}
