// Incident lifecycle in the database: open, update, reopen inside the flap window and resolve.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { db } from "@/lib/db";
import { incidents, type IncidentRow } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { FLAP_WINDOW_MS, incidentKey, incidentRef, incidentSubject } from "./key";
import type { IncidentRef, IncidentSeverity } from "./types";

const log = logger.child("incidents");

const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 20);

const RANK: Record<string, number> = { warning: 1, critical: 2 };
const rank = (s: string) => RANK[s] ?? 0;
const worse = (a: string, b: string) => (rank(a) >= rank(b) ? a : b) as IncidentSeverity;

export type OpenRequest = {
  kind: string;
  /** The throttle's subject. */
  about: string;
  severity: IncidentSeverity;
  title: string;
  appId?: string;
};

const openWhere = (organizationId: string, key: string) =>
  and(eq(incidents.organizationId, organizationId), eq(incidents.key, key), eq(incidents.state, "open"));

async function bump(row: IncidentRow, severity: IncidentSeverity, now: Date): Promise<IncidentRef> {
  const [updated] = await db
    .update(incidents)
    .set({
      severity,
      peakSeverity: worse(row.peakSeverity, severity),
      updatedAt: now,
      updateCount: sql`${incidents.updateCount} + 1`,
      lastNotifiedState: "updated",
      lastNotifiedAt: now,
    })
    .where(eq(incidents.id, row.id))
    .returning();
  return incidentRef(updated ?? row, "updated", rank(severity) > rank(row.severity) ? "escalated" : "repeated");
}

/** Resolved recently enough that coming back is the same incident. */
export function withinFlapWindow(row: Pick<IncidentRow, "resolvedAt">, now: Date): boolean {
  return row.resolvedAt !== null && now.getTime() - row.resolvedAt.getTime() <= FLAP_WINDOW_MS;
}

/** Opens an incident for a notice about to go out, or updates the one already open. Reuses one resolved inside the flap window. */
export async function openIncident(organizationId: string, req: OpenRequest, now: Date): Promise<IncidentRef> {
  const key = incidentKey(req.kind, req.about);

  const open = await db.query.incidents.findFirst({ where: openWhere(organizationId, key) });
  if (open) return bump(open, req.severity, now);

  const recent = await db.query.incidents.findFirst({
    where: and(eq(incidents.organizationId, organizationId), eq(incidents.key, key), eq(incidents.state, "resolved")),
    orderBy: [desc(incidents.resolvedAt)],
  });
  if (recent && withinFlapWindow(recent, now)) {
    const [reopened] = await db
      .update(incidents)
      .set({
        state: "open",
        resolvedAt: null,
        severity: req.severity,
        title: req.title,
        peakSeverity: worse(recent.peakSeverity, req.severity),
        updatedAt: now,
        updateCount: sql`${incidents.updateCount} + 1`,
        reopenCount: sql`${incidents.reopenCount} + 1`,
        lastNotifiedState: "updated",
        lastNotifiedAt: now,
      })
      .where(and(eq(incidents.id, recent.id), eq(incidents.state, "resolved")))
      .returning();
    if (reopened) return incidentRef(reopened, "updated", "reopened");
  }

  const subject = incidentSubject(req.kind, req.about);
  const [inserted] = await db
    .insert(incidents)
    .values({
      id: `inc_${newId()}`,
      organizationId,
      key,
      kind: req.kind,
      subjectType: subject.type,
      subjectId: subject.id,
      appId: req.appId ?? null,
      title: req.title,
      severity: req.severity,
      peakSeverity: req.severity,
      state: "open",
      openedAt: now,
      updatedAt: now,
      lastNotifiedState: "opened",
      lastNotifiedAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return incidentRef(inserted, "opened");

  // Another process opened it first.
  const winner = await db.query.incidents.findFirst({ where: openWhere(organizationId, key) });
  if (!winner) throw new Error(`Incident ${key} neither opened nor found`);
  return bump(winner, req.severity, now);
}

/** Resolves the open incidents for these subjects of a kind. */
export async function resolveIncidents(organizationId: string, kind: string, abouts: string[], now: Date): Promise<Map<string, IncidentRef>> {
  const out = new Map<string, IncidentRef>();
  if (abouts.length === 0) return out;
  const byKey = new Map(abouts.map((about) => [incidentKey(kind, about), about]));
  const rows = await db
    .update(incidents)
    .set({ state: "resolved", resolvedAt: now, updatedAt: now, lastNotifiedState: "resolved", lastNotifiedAt: now })
    .where(and(eq(incidents.organizationId, organizationId), eq(incidents.state, "open"), inArray(incidents.key, [...byKey.keys()])))
    .returning();
  for (const row of rows ?? []) {
    const about = byKey.get(row.key);
    if (about !== undefined) out.set(about, incidentRef(row, "resolved"));
  }
  if (out.size > 0) void recordResolutions(organizationId, [...out.values()]);
  return out;
}

/** Severity of every open incident in the org, by key. */
export async function openSeverities(organizationId: string): Promise<Map<string, string>> {
  const rows = await db.query.incidents.findMany({
    where: and(eq(incidents.organizationId, organizationId), eq(incidents.state, "open")),
    columns: { key: true, severity: true },
  });
  return new Map((rows ?? []).map((r) => [r.key, r.severity]));
}

/** Records a lower severity without a notice. */
export async function lowerSeverity(organizationId: string, key: string, severity: IncidentSeverity, now: Date): Promise<void> {
  await db.update(incidents).set({ severity, updatedAt: now }).where(openWhere(organizationId, key));
}

export async function channelMessage(incidentId: string, channelId: string): Promise<string | null> {
  const row = await db.query.incidents.findFirst({ where: eq(incidents.id, incidentId), columns: { channelMessages: true } });
  return row?.channelMessages?.[channelId] ?? null;
}

export async function rememberChannelMessage(incidentId: string, channelId: string, messageId: string): Promise<void> {
  await db
    .update(incidents)
    .set({ channelMessages: sql`${incidents.channelMessages} || jsonb_build_object(${channelId}::text, ${messageId}::text)` })
    .where(eq(incidents.id, incidentId));
}

/** One activity row per resolution. Best-effort. */
async function recordResolutions(organizationId: string, refs: IncidentRef[]): Promise<void> {
  try {
    const { recordActivity } = await import("@/lib/activity/record");
    for (const ref of refs) {
      await recordActivity({
        organizationId,
        action: ref.appId ? "app.incident_resolved" : "system.incident_resolved",
        appId: ref.appId,
        metadata: { incidentId: ref.id, kind: ref.kind, title: ref.title, openForMs: ref.durationMs },
      });
    }
  } catch (err) {
    log.warn("Recording incident resolutions failed:", err);
  }
}

/** Runs an incident write without letting it cost the notice. */
export async function safely<T>(what: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    log.error(`Incident ${what} failed:`, err);
    return fallback;
  }
}
