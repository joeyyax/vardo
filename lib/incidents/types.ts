// The incident a notification belongs to, as receivers see it.

/** Webhook payload schema version. 2 adds `id`, `incident` and per-incident delivery. */
export const PAYLOAD_VERSION = 2;

export type IncidentState = "open" | "resolved";

/** What this notice did to the incident. */
export type IncidentTransition = "opened" | "updated" | "resolved";

export type IncidentSeverity = "warning" | "critical";

export type IncidentSubjectType = "app" | "host" | "volume" | "cron-job" | "service" | "domain";

/** Structured fields and Vardo's own wording only: never log lines, errors or env values. */
export type IncidentRef = {
  id: string;
  key: string;
  kind: string;
  state: IncidentState;
  transition: IncidentTransition;
  /** Why an update went out. */
  reason?: "escalated" | "reopened" | "repeated";
  severity: IncidentSeverity;
  peakSeverity: IncidentSeverity;
  subject: { type: IncidentSubjectType; id: string };
  appId?: string;
  title: string;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** Open to resolved, on resolution. */
  durationMs?: number;
  updates: number;
  url: string;
};
