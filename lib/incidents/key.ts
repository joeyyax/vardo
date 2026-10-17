// Deterministic incident keys and the fields built from a stored incident.

import type { IncidentRow } from "@/lib/db/schema";
import type { IncidentRef, IncidentSeverity, IncidentSubjectType, IncidentTransition } from "./types";

/** A resolved incident that reopens inside this window keeps its id. */
export const FLAP_WINDOW_MS = 30 * 60_000;

const SUBJECT_BY_PREFIX: [string, IncidentSubjectType][] = [
  ["host.", "host"],
  ["app.", "app"],
  ["deploy.", "app"],
  ["backup.", "volume"],
  ["cron.", "cron-job"],
  ["system.service", "service"],
  ["system.update", "service"],
  ["system.lifecycle", "service"],
  ["system.loop", "service"],
  ["system.cert", "domain"],
  ["uptime.", "domain"],
];

export function incidentSubject(kind: string, about: string): { type: IncidentSubjectType; id: string } {
  const type = SUBJECT_BY_PREFIX.find(([prefix]) => kind.startsWith(prefix))?.[1] ?? "app";
  return { type, id: type === "host" && about === "host" ? "local" : about };
}

/** `app:<id>:app.restart-loop`, `host:local:host.cpu`. Same subject and kind, same key. */
export function incidentKey(kind: string, about: string): string {
  const subject = incidentSubject(kind, about);
  return `${subject.type}:${subject.id}:${kind}`;
}

export function consoleBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");
}

/** The console page for the subject. */
export function incidentUrl(
  row: Pick<IncidentRow, "subjectType" | "appId"> & Partial<Pick<IncidentRow, "kind" | "subjectId">>,
  baseUrl = consoleBaseUrl(),
): string {
  if (row.kind?.startsWith("uptime.") && row.subjectId) return `${baseUrl}/uptime/${encodeURIComponent(row.subjectId)}`;
  if (row.appId) return `${baseUrl}/apps/${encodeURIComponent(row.appId)}`;
  switch (row.subjectType) {
    case "host":
      return `${baseUrl}/metrics`;
    case "cron-job":
      return `${baseUrl}/cron`;
    case "volume":
      return `${baseUrl}/backups`;
    default:
      return baseUrl;
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** The payload for a stored incident. Whitelisted fields only. */
export function incidentRef(
  row: IncidentRow,
  transition: IncidentTransition,
  reason?: IncidentRef["reason"],
  baseUrl?: string,
): IncidentRef {
  return {
    id: row.id,
    key: row.key,
    kind: row.kind,
    state: row.state,
    transition,
    ...(reason ? { reason } : {}),
    severity: row.severity as IncidentSeverity,
    peakSeverity: row.peakSeverity as IncidentSeverity,
    subject: { type: row.subjectType as IncidentSubjectType, id: row.subjectId },
    ...(row.appId ? { appId: row.appId } : {}),
    title: row.title,
    openedAt: row.openedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    resolvedAt: iso(row.resolvedAt),
    ...(row.resolvedAt ? { durationMs: Math.max(0, row.resolvedAt.getTime() - row.openedAt.getTime()) } : {}),
    updates: row.updateCount,
    url: incidentUrl(row, baseUrl),
  };
}
