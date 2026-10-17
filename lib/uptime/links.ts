// The per-peer switches for uptime checks, and the vantage points they produce.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { meshPeers, uptimeVantages, uptimeWatchEntries } from "@/lib/db/schema";
import type { LinkPatch } from "./link";
import type { VantageLinkView } from "./types";

async function viewOf(peerId: string): Promise<VantageLinkView | null> {
  return (await listVantageLinks()).find((l) => l.peerId === peerId) ?? null;
}

/** Every directly linked instance, with both switches and the vantage point it became here. */
export async function listVantageLinks(): Promise<VantageLinkView[]> {
  const [peers, vantages, watched] = await Promise.all([
    db.query.meshPeers.findMany({
      where: eq(meshPeers.connectionType, "direct"),
      columns: { id: true, name: true, status: true, uptimeChecksUs: true, uptimeChecksPeer: true },
    }),
    db.select().from(uptimeVantages),
    db.select({ peerId: uptimeWatchEntries.peerId, fetchedAt: uptimeWatchEntries.fetchedAt }).from(uptimeWatchEntries),
  ]);
  return peers
    .map((p) => {
      const vantage = vantages.find((v) => v.meshPeerId === p.id);
      const mine = watched.filter((w) => w.peerId === p.id);
      return {
        peerId: p.id,
        name: p.name,
        online: p.status === "online",
        checksThisInstance: p.uptimeChecksUs,
        thisInstanceChecks: p.uptimeChecksPeer,
        vantage: vantage ? { id: vantage.id, name: vantage.name, kind: "external" as const, location: vantage.location } : null,
        watching: mine.length,
        lastFetchedAt: mine.reduce<number | null>((best, w) => (!best || w.fetchedAt.getTime() > best ? w.fetchedAt.getTime() : best), null),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Applies the switches. Turning one off takes effect now: the peer's results stop counting, or our probing of it stops. */
export async function setVantageLink(peerId: string, patch: LinkPatch): Promise<VantageLinkView | null> {
  const [peer] = await db
    .update(meshPeers)
    .set({
      ...(patch.checksThisInstance !== undefined ? { uptimeChecksUs: patch.checksThisInstance } : {}),
      ...(patch.thisInstanceChecks !== undefined ? { uptimeChecksPeer: patch.thisInstanceChecks } : {}),
      updatedAt: new Date(),
    })
    .where(eq(meshPeers.id, peerId))
    .returning({ id: meshPeers.id });
  if (!peer) return null;
  if (patch.checksThisInstance === false) await db.update(uptimeVantages).set({ watching: [], meshWatching: [] }).where(eq(uptimeVantages.meshPeerId, peerId));
  if (patch.thisInstanceChecks === false) await db.delete(uptimeWatchEntries).where(eq(uptimeWatchEntries.peerId, peerId));
  return viewOf(peerId);
}
