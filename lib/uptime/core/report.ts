// Reports: what an owner tells its linked peers about the monitors they don't check themselves. State and timings only, never a URL, header or body.

import { z } from "zod";
import { checkHost } from "./address";
import type { Observation } from "./damping";
import type { Outage } from "./summary";
import type { Check, MonitorState } from "./types";

/** How often an owner sends its report. */
export const REPORT_EVERY_MS = 60_000;
/** A peer's report goes stale this long after it last arrived: two missed reports and some slack. */
export const REPORT_STALE_MS = 150_000;
/** The owner counts a peer as watching while it took a report this recently. */
export const REPORT_ACCEPTED_FRESH_MS = 3 * REPORT_EVERY_MS;
/** Oldest report a peer accepts, by its own clock, and how far ahead. */
const MAX_AGE_MS = 10 * 60_000;
const MAX_SKEW_MS = 5 * 60_000;
export const MAX_REPORTED = 2000;
export const MAX_REPORTED_OUTAGES = 20;

export const CONTAINER_STATES = ["healthy", "unhealthy", "crash-looping"] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];

export type ReportedMonitor = {
  monitorId: string;
  /** The checked host: a name or an address, never a URL. */
  host: string;
  state: MonitorState;
  /** Epoch ms it went down, while it's down. */
  downSince?: number;
  /** Median response time of the recent successful checks. */
  latencyMs: number | null;
  /** The app's container, when the monitor belongs to an app. */
  container: ContainerState | null;
  /** Outages in the last 24 hours, oldest first. */
  outages: Outage[];
  /** The owner silenced alerts for it: muted, in maintenance or waiting on review. */
  quiet: boolean;
};

const LABEL = "[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";
const HOST_RE = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|[0-9A-Fa-f:.]{2,45})$`);

/** A bare host name or address: no scheme, port, path, query or credentials. */
export const isReportableHost = (host: string) => host.length <= 253 && HOST_RE.test(host);

const epoch = z.number().int().min(0);

/** One reported monitor as a peer reads it. Any field beyond these refuses the report. */
export const reportedMonitorSchema = z
  .object({
    monitorId: z.string().min(1).max(100),
    host: z.string().refine(isReportableHost, "host only"),
    state: z.enum(["up", "degraded", "down", "unknown"]),
    downSince: epoch.optional(),
    latencyMs: z.number().int().min(0).max(600_000).nullable(),
    container: z.enum(CONTAINER_STATES).nullable(),
    outages: z.array(z.object({ start: epoch, end: epoch.nullable() }).strict()).max(MAX_REPORTED_OUTAGES),
    quiet: z.boolean(),
  })
  .strict();

/** The report entry for one monitor, or null when its host can't be named on its own. */
export function reportEntry(input: {
  monitorId: string;
  check: Check;
  state: MonitorState;
  downSince?: number;
  latencyMs: number | null;
  container: ContainerState | null;
  outages: Outage[];
  quiet: boolean;
}): ReportedMonitor | null {
  const host = checkHost(input.check);
  if (!isReportableHost(host)) return null;
  return {
    monitorId: input.monitorId,
    host,
    state: input.state,
    ...(input.state === "down" && input.downSince !== undefined ? { downSince: input.downSince } : {}),
    latencyMs: input.latencyMs,
    container: input.container,
    outages: input.outages.slice(-MAX_REPORTED_OUTAGES).map((o) => ({ start: o.start, end: o.end })),
    quiet: input.quiet,
  };
}

/** The monitors of a verified report payload, or why a peer refuses it. `lastIssuedAt` is the newest report already taken from this owner. */
export function readReport(
  payload: { issuedAt: number; monitors: unknown },
  now: number,
  lastIssuedAt: number | null,
): { monitors: ReportedMonitor[] } | { error: string } {
  if (!Number.isFinite(payload.issuedAt) || payload.issuedAt > now + MAX_SKEW_MS || payload.issuedAt < now - MAX_AGE_MS) return { error: "timestamp out of range" };
  if (lastIssuedAt !== null && payload.issuedAt <= lastIssuedAt) return { error: "older than the last report" };
  if (!Array.isArray(payload.monitors) || payload.monitors.length > MAX_REPORTED) return { error: "malformed report" };
  const monitors: ReportedMonitor[] = [];
  const seen = new Set<string>();
  for (const raw of payload.monitors) {
    const parsed = reportedMonitorSchema.safeParse(raw);
    if (!parsed.success) return { error: "malformed monitor" };
    if (seen.has(parsed.data.monitorId)) return { error: "duplicate monitor" };
    seen.add(parsed.data.monitorId);
    monitors.push(parsed.data);
  }
  return { monitors };
}

/** What a reported monitor tells the watcher's damping. Null for no data or a monitor its owner silenced. */
export function reportObservation(m: ReportedMonitor): Observation | null {
  if (m.quiet || m.state === "unknown") return null;
  return { state: m.state, key: m.state };
}

/** Whether a peer's reports are arriving: none when it never sent one. */
export function reportFreshness(receivedAt: number | null, now: number): "fresh" | "stale" | "none" {
  if (receivedAt === null) return "none";
  return now - receivedAt <= REPORT_STALE_MS ? "fresh" : "stale";
}
