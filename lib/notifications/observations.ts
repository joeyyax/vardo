// One alert pass for an org: drops what it switched off, sends what's new, clears what stopped holding.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { alertHistory } from "@/lib/db/schema";
import type { AlertItem } from "@/lib/bus/events";
import { emit } from "./dispatch";
import { readOrgNotificationSettings } from "./preferences";
import { ALERTS, severityRank, type AlertSeverity, type AlertType } from "./registry";
import { claimNotifications, clearNotifications, clearSubjects } from "./throttle";

export type Observation = {
  type: AlertType;
  about: string;
  severity: AlertSeverity;
  /** Meets the rule to send now. False while it only holds inside the clear margin. */
  fires: boolean;
  item: AlertItem;
};

export type ResolvedItem = AlertItem & { firedAt: string; resolvedAt: string };

/** Worst first, then by title. */
export function sortAlerts<T extends AlertItem>(items: T[]): T[] {
  return [...items].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || a.title.localeCompare(b.title));
}

function firedTitle(items: AlertItem[]): string {
  return items.length === 1 ? items[0].title : `${items.length} alerts: ${items[0].title} and more`;
}

async function openHistory(organizationId: string, type: string, items: AlertItem[], escalated: AlertItem[], now: Date): Promise<void> {
  if (items.length > 0) {
    await db.insert(alertHistory).values(
      items.map((item) => ({
        id: nanoid(),
        organizationId,
        type,
        about: item.about,
        severity: item.severity,
        title: item.title,
        firedAt: now,
      })),
    );
  }
  for (const item of escalated) {
    await db
      .update(alertHistory)
      .set({ severity: item.severity, title: item.title })
      .where(and(eq(alertHistory.organizationId, organizationId), eq(alertHistory.type, type), eq(alertHistory.about, item.about), isNull(alertHistory.resolvedAt)));
  }
}

async function closeHistory(organizationId: string, type: string, abouts: string[], now: Date): Promise<void> {
  if (abouts.length === 0) return;
  await db
    .update(alertHistory)
    .set({ resolvedAt: now })
    .where(
      and(
        eq(alertHistory.organizationId, organizationId),
        eq(alertHistory.type, type),
        inArray(alertHistory.about, abouts),
        isNull(alertHistory.resolvedAt),
      ),
    );
}

/** Runs the evaluated types for one org and emits at most one fired and one resolved notice. */
export async function notifyObservations(
  organizationId: string,
  evaluated: AlertType[],
  observations: Observation[],
  now: Date,
): Promise<{ fired: AlertItem[]; resolved: ResolvedItem[] }> {
  const settings = await readOrgNotificationSettings(organizationId);
  const fired: AlertItem[] = [];
  const resolved: ResolvedItem[] = [];

  for (const type of evaluated) {
    const def = ALERTS[type];
    const muted = !settings.categories[def.category];
    const ofType = muted ? [] : observations.filter((o) => o.type === type);

    const claims = await claimNotifications(
      organizationId,
      type,
      ofType.filter((o) => o.fires).map((o) => ({ about: o.about, severity: o.severity, detail: o.item })),
      def.throttle.minHours,
      now,
    );
    const byAbout = new Map(ofType.map((o) => [o.about, o.item]));
    const opened: AlertItem[] = [];
    const escalated: AlertItem[] = [];
    for (const claim of claims) {
      const item = byAbout.get(claim.about);
      if (!item) continue;
      fired.push(item);
      (claim.previous && claim.previous.clearedAt === null ? escalated : opened).push(item);
    }
    await openHistory(organizationId, type, opened, escalated, now);

    const cleared = await clearNotifications(organizationId, type, ofType.map((o) => o.about), now);
    await closeHistory(organizationId, type, cleared.map((c) => c.about), now);
    // A switch turned off clears quietly.
    if (!def.resolves || muted) continue;
    for (const row of cleared) {
      if (!row.detail) continue;
      resolved.push({ ...(row.detail as AlertItem), firedAt: row.sentAt.toISOString(), resolvedAt: now.toISOString() });
    }
  }

  if (fired.length > 0) {
    const alerts = sortAlerts(fired);
    emit(organizationId, {
      type: "alert.fired",
      title: firedTitle(alerts),
      message: alerts.map((a) => a.title).join("; "),
      alerts,
    });
  }
  if (resolved.length > 0) {
    const alerts = sortAlerts(resolved);
    emit(organizationId, {
      type: "alert.resolved",
      title: alerts.length === 1 ? `Resolved: ${alerts[0].title}` : `${alerts.length} alerts resolved`,
      message: alerts.map((a) => a.title).join("; "),
      alerts,
    });
  }
  return { fired, resolved };
}

/** Claims one alert through the throttle and records it, without sending. Returns whether it's due. */
export async function claimAlert(organizationId: string, type: AlertType, item: AlertItem, now: Date): Promise<boolean> {
  const claims = await claimNotifications(organizationId, type, [{ about: item.about, severity: item.severity, detail: item }], ALERTS[type].throttle.minHours, now);
  if (claims.length === 0) return false;
  const reopened = claims[0].previous !== null && claims[0].previous.clearedAt === null;
  await openHistory(organizationId, type, reopened ? [] : [item], reopened ? [item] : [], now);
  return true;
}

/** Sends one alert now, through the throttle, whatever the org's switches. Returns whether it sent. */
export async function fireAlert(organizationId: string, type: AlertType, item: AlertItem, now: Date): Promise<boolean> {
  if (!(await claimAlert(organizationId, type, item, now))) return false;
  emit(organizationId, { type: "alert.fired", title: item.title, message: item.title, alerts: [item] });
  return true;
}

/** Clears one subject and sends a resolved notice when the type has one. Returns whether it was open. */
export async function resolveAlert(organizationId: string, type: AlertType, about: string, now: Date, notify = true): Promise<boolean> {
  const cleared = await clearNotifications(organizationId, type, [], now, [about]);
  if (cleared.length === 0) return false;
  await closeHistory(organizationId, type, [about], now);
  const row = cleared[0];
  if (!notify || !ALERTS[type].resolves || !row.detail) return true;
  const item: ResolvedItem = { ...(row.detail as AlertItem), firedAt: row.sentAt.toISOString(), resolvedAt: now.toISOString() };
  emit(organizationId, { type: "alert.resolved", title: `Resolved: ${item.title}`, message: item.title, alerts: [item] });
  return true;
}

/** Clears alerts whose subjects recovered, without a notice. */
export async function settleAlerts(organizationId: string, type: AlertType, abouts: string[], now: Date): Promise<void> {
  const cleared = await clearSubjects(organizationId, type, abouts, now);
  await closeHistory(organizationId, type, cleared, now);
}
