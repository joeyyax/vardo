// What the uptime API returns and accepts. Safe to import from client components.

import { z } from "zod";
import type { Check, ErrorKind, IntervalSec, MaintenanceWindow, MonitorState } from "./core/types";

export type { Check, ErrorKind, IntervalSec, MaintenanceWindow, MonitorState };

export type Scope = { kind: "org"; orgId: string } | { kind: "instance" };

export type DayTick = {
  /** Epoch ms of the UTC day start. */
  start: number;
  minutesUp: number;
  minutesDown: number;
  minutesUnknown: number;
  uptimePct: number | null;
};

export type MonitorSummary = {
  id: string;
  name: string;
  /** What the check hits, such as `https://example.com` or `db.example.com:5432`. */
  target: string;
  check: Check;
  intervalSec: IntervalSec;
  muted: boolean;
  enabled: boolean;
  source: "auto" | "manual";
  preview: boolean;
  appId: string | null;
  domainId: string | null;
  maintenance: MaintenanceWindow[];
  state: MonitorState;
  /** Only the local vantage point decided. */
  localOnly: boolean;
  /** Epoch ms the monitor went down, while it's down. */
  downSince: number | null;
  uptime30: number | null;
  /** The last 30 UTC days, oldest first. */
  daily: DayTick[];
  latencyMs: number | null;
  lastCheckedAt: number | null;
};

export type VantageView = {
  id: string;
  name: string;
  kind: "local" | "external";
  location: string | null;
};

/** A linked instance and the two uptime switches on its link. */
export type VantageLinkView = {
  peerId: string;
  name: string;
  online: boolean;
  /** The peer checks this instance. */
  checksThisInstance: boolean;
  /** This instance checks the peer. */
  thisInstanceChecks: boolean;
  /** The peer's vantage point here, once it has announced itself. */
  vantage: VantageView | null;
  /** Monitors this instance checks for the peer. */
  watching: number;
  lastFetchedAt: number | null;
};

export type VantageStateView = VantageView & {
  state: "up" | "failing" | "unknown";
  lastResult: { at: number; ok: boolean; latencyMs: number; status: number | null; error: ErrorKind | null } | null;
  /** Epoch ms of the newest signed hourly summary. */
  signedAt: number | null;
};

export type LatencySeries = { vantageId: string; name: string; points: { at: number; ms: number }[] };

export type OutageView = { start: number; end: number | null; durationMs: number; incidentId: string | null };

export type MonitorDetail = MonitorSummary & {
  uptime24h: number | null;
  uptime90d: number | null;
  daily90: DayTick[];
  medianLatency24h: number | null;
  latency24h: LatencySeries[];
  vantages: VantageStateView[];
  outages: OutageView[];
  /** Names of the org's notification channels that hear about outages. */
  channels: string[];
};

export type AppUptime = {
  monitors: MonitorSummary[];
  state: MonitorState;
  localOnly: boolean;
  downSince: number | null;
  lastCheckedAt: number | null;
  vantageName: string | null;
  uptime24h: number | null;
  uptime30d: number | null;
  uptime90d: number | null;
  daily90: DayTick[];
  medianLatency24h: number | null;
  lastOutage: { start: number; end: number | null } | null;
};

const hostSchema = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:_-]+$/, "Enter a hostname or address");
const portSchema = z.number().int().min(1).max(65535);

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((v) => {
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "Enter an http or https URL");

const intervalSchema = z.union([z.literal(30), z.literal(60), z.literal(300)]);

const windowSchema = z
  .object({ start: z.number().int(), end: z.number().int() })
  .refine((w) => w.end > w.start, "The window must end after it starts");

export const createMonitorSchema = z
  .object({
    type: z.enum(["http", "tcp", "tls"]),
    name: z.string().trim().max(80).optional(),
    url: httpUrl.optional(),
    host: hostSchema.optional(),
    port: portSchema.optional(),
    expectedStatus: z.object({ min: z.number().int().min(100).max(599), max: z.number().int().min(100).max(599) }).optional(),
    timeoutMs: z.number().int().min(1000).max(60_000).optional(),
    keyword: z.string().trim().max(200).optional(),
    warnDays: z.number().int().min(1).max(365).optional(),
    intervalSec: intervalSchema.optional(),
  })
  .strict();

export const updateMonitorSchema = createMonitorSchema
  .partial()
  .extend({
    muted: z.boolean().optional(),
    enabled: z.boolean().optional(),
    maintenance: z.array(windowSchema).max(50).optional(),
    /** Null clears the keyword. */
    keyword: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const muteSchema = z.object({ muted: z.boolean() }).strict();

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
