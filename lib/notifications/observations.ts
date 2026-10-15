// One alert pass for an org: drops what it switched off, sends what's new, clears what stopped holding.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { alertHistory } from "@/lib/db/schema";
import type { AlertItem } from "@/lib/bus/events";
import { emit } from "./dispatch";
import { readOrgNotificationSettings } from "./preferences";
import { ALERTS, severityRank, sortAlerts, type AlertSeverity, type AlertType } from "./registry";
import { holdResolved, resolvedNotice, sendHeldResolved, type ResolvedItem } from "./resolved-hold";
import { claimNotifications, clearNotifications, clearSubjects, type Cleared } from "./throttle";
import { incidentKey } from "@/lib/incidents/key";
import { lowerSeverity, openIncident, openSeverities, resolveIncidents, safely } from "@/lib/incidents/store";
import type { IncidentRef } from "@/lib/incidents/types";

export type Observation = {
  type: AlertType;
  about: string;
  severity: AlertSeverity;
  /** Meets the rule to send now. False while it only holds inside the clear margin. */
  fires: boolean;
  item: AlertItem;
};

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

/** The alert with the incident its notice opens or updates. */
async function withIncident(organizationId: string, item: AlertItem, now: Date): Promise<AlertItem> {
  const incident = await safely(
    "open",
    () => openIncident(organizationId, { kind: item.type, about: item.about, severity: item.severity, title: item.title, appId: item.appId }, now),
    null,
  );
  return incident ? { ...item, incident } : item;
}

/** Resolves the incidents behind cleared rows, by subject. */
async function resolveCleared(organizationId: string, type: string, cleared: Cleared[], now: Date): Promise<Map<string, IncidentRef>> {
  return safely("resolve", () => resolveIncidents(organizationId, type, cleared.map((c) => c.about), now), new Map());
}

function resolvedItem(row: Cleared, now: Date, incident: IncidentRef | undefined): ResolvedItem {
  return { ...(row.detail as AlertItem), firedAt: row.sentAt.toISOString(), resolvedAt: now.toISOString(), ...(incident ? { incident } : {}) };
}

/** A resolution only webhooks see: the incident and Vardo's title, nothing from the alert's detail. */
function quietItem(row: Cleared, now: Date, incident: IncidentRef): ResolvedItem {
  const detail = (row.detail ?? {}) as Partial<AlertItem>;
  return {
    type: incident.kind,
    about: row.about,
    severity: incident.severity,
    title: incident.title,
    detail: "",
    ...(detail.appId ? { appId: detail.appId } : {}),
    ...(detail.appName ? { appName: detail.appName } : {}),
    firedAt: row.sentAt.toISOString(),
    resolvedAt: now.toISOString(),
    incident,
  };
}

/** Webhooks get each resolution now. Email and push get it in the org's grouped notice, unless it's quiet. */
async function emitResolved(organizationId: string, items: ResolvedItem[], now: Date, quiet = false): Promise<void> {
  if (items.length === 0) return;
  emit(organizationId, resolvedNotice(items, quiet ? { quiet } : { held: true }));
  if (!quiet) await holdResolved(organizationId, items, now);
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
  const quiet: ResolvedItem[] = [];
  const severities = await safely("read", () => openSeverities(organizationId), new Map<string, string>());

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
    const claimed = new Set<string>();
    for (const claim of claims) {
      const base = byAbout.get(claim.about);
      if (!base) continue;
      claimed.add(claim.about);
      const item = await withIncident(organizationId, base, now);
      fired.push(item);
      (claim.previous && claim.previous.clearedAt === null ? escalated : opened).push(item);
    }
    await openHistory(organizationId, type, opened, escalated, now);

    // A drop in severity updates the incident without a notice.
    for (const o of ofType) {
      if (claimed.has(o.about)) continue;
      const key = incidentKey(type, o.about);
      const current = severities.get(key);
      if (current && severityRank(o.severity) < severityRank(current)) {
        await safely("lower", () => lowerSeverity(organizationId, key, o.severity, now), undefined);
      }
    }

    const cleared = await clearNotifications(organizationId, type, ofType.map((o) => o.about), now);
    await closeHistory(organizationId, type, cleared.map((c) => c.about), now);
    const incidents = await resolveCleared(organizationId, type, cleared, now);
    // A switch turned off, or a type without a resolved notice, closes the incident for webhooks only.
    const notify = def.resolves && !muted;
    for (const row of cleared) {
      const incident = incidents.get(row.about);
      if (notify && row.detail) resolved.push(resolvedItem(row, now, incident));
      else if (incident) quiet.push(quietItem(row, now, incident));
    }
  }

  if (fired.length > 0) {
    // Held resolutions go first, so none lands after an alert that fired again.
    await sendHeldResolved(organizationId, now.getTime(), true);
    const alerts = sortAlerts(fired);
    emit(organizationId, {
      type: "alert.fired",
      title: firedTitle(alerts),
      message: alerts.map((a) => a.title).join("; "),
      alerts,
      ...(alerts.length === 1 && alerts[0].incident ? { incident: alerts[0].incident } : {}),
    });
  }
  await emitResolved(organizationId, resolved, now);
  await emitResolved(organizationId, quiet, now, true);
  return { fired, resolved };
}

/** Claims one alert through the throttle and records it, without sending. Returns the alert with its incident when due, else null. */
export async function claimAlert(organizationId: string, type: AlertType, item: AlertItem, now: Date): Promise<AlertItem | null> {
  const claims = await claimNotifications(organizationId, type, [{ about: item.about, severity: item.severity, detail: item }], ALERTS[type].throttle.minHours, now);
  if (claims.length === 0) return null;
  const reopened = claims[0].previous !== null && claims[0].previous.clearedAt === null;
  const claimed = await withIncident(organizationId, item, now);
  await openHistory(organizationId, type, reopened ? [] : [claimed], reopened ? [claimed] : [], now);
  return claimed;
}

/** Sends one alert now, through the throttle, whatever the org's switches. Returns whether it sent. */
export async function fireAlert(organizationId: string, type: AlertType, item: AlertItem, now: Date): Promise<boolean> {
  const claimed = await claimAlert(organizationId, type, item, now);
  if (!claimed) return false;
  emit(organizationId, {
    type: "alert.fired",
    title: claimed.title,
    message: claimed.title,
    alerts: [claimed],
    ...(claimed.incident ? { incident: claimed.incident } : {}),
  });
  return true;
}

/** Clears one subject and sends a resolved notice when the type has one. Returns whether it was open. */
export async function resolveAlert(organizationId: string, type: AlertType, about: string, now: Date, notify = true): Promise<boolean> {
  const cleared = await clearNotifications(organizationId, type, [], now, [about]);
  if (cleared.length === 0) return false;
  await closeHistory(organizationId, type, [about], now);
  const row = cleared[0];
  const incident = (await resolveCleared(organizationId, type, cleared, now)).get(about);
  if (notify && ALERTS[type].resolves && row.detail) await emitResolved(organizationId, [resolvedItem(row, now, incident)], now);
  else if (incident) await emitResolved(organizationId, [quietItem(row, now, incident)], now, true);
  return true;
}

/** Clears alerts whose subjects recovered. Webhooks see the incident close; email and push stay quiet. */
export async function settleAlerts(organizationId: string, type: AlertType, abouts: string[], now: Date): Promise<void> {
  const cleared = await clearSubjects(organizationId, type, abouts, now);
  await closeHistory(organizationId, type, cleared.map((c) => c.about), now);
  const incidents = await resolveCleared(organizationId, type, cleared, now);
  await emitResolved(
    organizationId,
    cleared.flatMap((row) => {
      const incident = incidents.get(row.about);
      return incident ? [quietItem(row, now, incident)] : [];
    }),
    now,
    true,
  );
}
