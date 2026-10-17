// Instance-wide problems as incidents: one per org that hears about them, resolved with a recovery notice.

import type { AlertItem, BusEvent } from "@/lib/bus/events";
import { emit } from "@/lib/notifications/dispatch";
import { openIncident, resolveIncidents, safely } from "./store";
import type { IncidentSeverity } from "./types";

/** Problems with Vardo's own processes on this host or a mesh peer. */
export type HostProblemKind =
  | "host.worker-down"
  | "host.watchdog-silent"
  | "host.peer-silent"
  | "host.peer-worker-down"
  | "host.peer-watchdog-silent";

export type SystemProblem = {
  kind: "system.service-down" | "uptime.down" | "system.cert-expiring" | "system.loop-failing" | HostProblemKind;
  about: string;
  title: string;
  severity: IncidentSeverity;
  appId?: string;
};

/** Emits the notice to each org with the incident it opens or updates there. */
export async function emitSystemIncident(orgIds: string[], event: BusEvent, problem: SystemProblem, now = new Date()): Promise<void> {
  for (const orgId of orgIds) {
    const incident = await safely(
      "open",
      () => openIncident(orgId, { kind: problem.kind, about: problem.about, severity: problem.severity, title: problem.title, appId: problem.appId }, now),
      null,
    );
    emit(orgId, incident ? { ...event, incident } : event);
  }
}

/** Resolves the problem in each org and sends the recovery there. Orgs without an open incident hear nothing. */
export async function resolveSystemIncident(
  orgIds: string[],
  kind: SystemProblem["kind"],
  about: string,
  detail: string,
  now = new Date(),
): Promise<void> {
  for (const orgId of orgIds) {
    const incident = (await safely("resolve", () => resolveIncidents(orgId, kind, [about], now), new Map())).get(about);
    if (!incident) continue;
    const item: AlertItem & { firedAt: string; resolvedAt: string } = {
      type: kind,
      about,
      severity: incident.severity,
      title: incident.title,
      detail,
      incident,
      firedAt: incident.openedAt,
      resolvedAt: now.toISOString(),
    };
    emit(orgId, { type: "alert.resolved", title: `Resolved: ${incident.title}`, message: incident.title, alerts: [item], incident });
  }
}
