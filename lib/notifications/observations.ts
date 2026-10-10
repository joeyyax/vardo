// One alert pass for an org: drops what it switched off, sends what's new, clears what stopped holding.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { alertHistory } from "@/lib/db/schema";
import type { AlertItem } from "@/lib/bus/events";
import { emit } from "./dispatch";
import { readOrgNotificationSettings } from "./preferences";
import { ALERTS, severityRank, type AlertSeverity, type AlertType } from "./registry";
import { claimNotifications, clearNotifications } from "./throttle";

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
