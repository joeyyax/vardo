// Trap and canary records: address, path, marker id and time only.

import { and, count, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, probeCanaries, probeEvents, type ProbeEventKind } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { generateMarker } from "./canary";
import { MAX_RENDERED_MARKERS } from "./traefik-file";
import { syncGuardFileSoon } from "./sync";

const EVENT_TTL_MS = 90 * 86_400_000;
const MARKER_TTL_MS = 30 * 86_400_000;

const EVENT_ACTIVITY: Partial<Record<ProbeEventKind, string>> = {
  trap: "security.trap_triggered",
  canary_used: "security.canary_used",
};

export async function recordEvent(e: {
  kind: ProbeEventKind;
  ip: string;
  path?: string | null;
  canaryId?: string | null;
  appId?: string | null;
}): Promise<void> {
  await db.insert(probeEvents).values({
    id: nanoid(),
    kind: e.kind,
    ip: e.ip,
    path: e.path ? e.path.slice(0, 200) : null,
    canaryId: e.canaryId ?? null,
    appId: e.appId ?? null,
  });
  const action = EVENT_ACTIVITY[e.kind];
  if (action && e.appId) {
    const app = await db.query.apps.findFirst({ where: eq(apps.id, e.appId), columns: { organizationId: true } });
    if (app) {
      await recordActivity({
        organizationId: app.organizationId,
        action,
        appId: e.appId,
        metadata: { ip: e.ip, ...(e.path ? { path: e.path.slice(0, 200) } : {}), ...(e.canaryId ? { canaryId: e.canaryId } : {}) },
      }).catch(() => {});
    }
  }
}

/** The address's decoy marker, made on its first fetch. */
export async function markerFor(ip: string, appId: string | null): Promise<{ id: string; marker: string }> {
  const [existing] = await db
    .select({ id: probeCanaries.id, marker: probeCanaries.marker })
    .from(probeCanaries)
    .where(eq(probeCanaries.ip, ip))
    .orderBy(desc(probeCanaries.lastFetchedAt))
    .limit(1);
  if (existing) {
    await db.update(probeCanaries).set({ lastFetchedAt: new Date() }).where(eq(probeCanaries.id, existing.id));
    return existing;
  }
  const row = { id: nanoid(), marker: generateMarker(), ip, appId };
  await db.insert(probeCanaries).values(row);
  syncGuardFileSoon();
  return { id: row.id, marker: row.marker };
}

export async function activeCanaries(now = new Date()): Promise<{ id: string; marker: string }[]> {
  return db
    .select({ id: probeCanaries.id, marker: probeCanaries.marker })
    .from(probeCanaries)
    .where(gt(probeCanaries.lastFetchedAt, new Date(now.getTime() - MARKER_TTL_MS)))
    .orderBy(desc(probeCanaries.lastFetchedAt))
    .limit(MAX_RENDERED_MARKERS);
}

export async function markUsed(canaryId: string): Promise<void> {
  await db.update(probeCanaries).set({ usedAt: new Date() }).where(and(eq(probeCanaries.id, canaryId), isNull(probeCanaries.usedAt)));
}

/** Trap hits since a time, for one app or all. */
export async function trapsSince(since: Date, appId?: string): Promise<number> {
  const filters = [gt(probeEvents.createdAt, since), eq(probeEvents.kind, "trap")];
  if (appId) filters.push(eq(probeEvents.appId, appId));
  const [row] = await db.select({ n: count() }).from(probeEvents).where(and(...filters));
  return row?.n ?? 0;
}

export async function pruneEvents(now = new Date()): Promise<void> {
  await db.delete(probeEvents).where(lt(probeEvents.createdAt, new Date(now.getTime() - EVENT_TTL_MS)));
  await db.delete(probeCanaries).where(lt(probeCanaries.lastFetchedAt, new Date(now.getTime() - 3 * MARKER_TTL_MS)));
}
