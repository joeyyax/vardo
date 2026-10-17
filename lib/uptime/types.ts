// What the uptime API returns and accepts. Safe to import from client components.

import { z } from "zod";
import type { UptimeRange } from "./core";
import type { Check, CheckPath, ErrorKind, AutoOverrides, HealthSource, IntervalSec, MaintenanceWindow, MonitorState, Reading, ReviewAnswer } from "./core";

export type { AutoOverrides, Check, CheckPath, ErrorKind, HealthSource, IntervalSec, MaintenanceWindow, MonitorState, Reading, ReviewAnswer };

/** A monitor state, or "review" while the operator hasn't said what counts as up. Review doesn't alert and counts as unknown. */
export type DisplayState = MonitorState | "review";

/** The question for an automatic monitor whose best answer is a non-2xx below 500. */
export type ReviewQuestion = { status: number; reason: "status" | "login" };

/** A monitor waiting on an answer. */
export type ReviewItem = { monitorId: string; name: string; appName: string | null; status: number; reason: "status" | "login" };

/** The app's container healthcheck, next to its uptime check. */
export type ContainerHealth = {
  hasHealthcheck: boolean;
  /** The path it requests, when it's a curl or wget on localhost. */
  path: string | null;
  /** The health path uptime could add as the container healthcheck, when the app has none. */
  offerPath: string | null;
};

export type DetectedHealth = {
  reachable: boolean;
  found: boolean;
  path: string | null;
  source: HealthSource | null;
  /** The URL the monitor would check. */
  url: string;
  review: ReviewQuestion | null;
};

export type Scope = { kind: "org"; orgId: string } | { kind: "instance" };

export type DayTick = {
  /** Epoch ms of the UTC day start. */
  start: number;
  minutesUp: number;
  minutesDown: number;
  minutesUnknown: number;
  uptimePct: number | null;
};

export type { UptimeRange };

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
  /** The app's name, which its page is addressed by. */
  appName: string | null;
  domainId: string | null;
  /** The domain this check is linked to was removed from the app. */
  domainRemoved: boolean;
  /** Epoch ms the monitor was created. */
  createdAt: number;
  /** What the operator edited on an automatic monitor. Null when it runs as detected. */
  overrides: AutoOverrides | null;
  /** The path an automatic monitor checks, or null for the homepage. */
  healthPath: string | null;
  /** How the path was found. Null before detection has run, and on manual monitors. */
  healthSource: HealthSource | null;
  /** Set while the operator hasn't said what counts as up. */
  review: ReviewQuestion | null;
  /** What the operator said counts as up. */
  reviewAnswer: ReviewAnswer | null;
  /** Names of the request headers. Values are never returned. */
  headers: string[];
  /** Linked instances get the headers and check this monitor too. */
  shareHeaders: boolean;
  /** Checked from this instance only, because it uses a private header. */
  privateHeader: boolean;
  maintenance: MaintenanceWindow[];
  state: DisplayState;
  /** Why the vantage points disagree, when they do. */
  reading: Reading | null;
  /** For a monitor peers don't check: this instance's name and the linked instances that took its last report. Null while none do. */
  report: { by: string; to: string[] } | null;
  /** The target is a site that opens in a browser. */
  openable: boolean;
  /** Only the local vantage point decided. */
  localOnly: boolean;
  /** Epoch ms the monitor went down, while it's down. */
  downSince: number | null;
  uptime30: number | null;
  /** The last 30 UTC days, oldest first. */
  daily: DayTick[];
  /** The range the bars and `rangeUptime` cover. */
  range: UptimeRange;
  /** Bars for the range, oldest first, starting where the monitor's history starts. */
  bars: DayTick[];
  /** Width of a bar in ms. */
  barMs: number;
  /** When the history starts, when that is inside the range. */
  since: number | null;
  /** Uptime over the history inside the range. */
  rangeUptime: number | null;
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
  path: CheckPath;
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
  range: UptimeRange;
  bars: DayTick[];
  barMs: number;
  since: number | null;
  rangeUptime: number | null;
  /** Epoch ms the oldest monitor was created. */
  historyStart: number | null;
  state: MonitorState;
  /** Monitors waiting on an answer. */
  reviews: MonitorSummary[];
  localOnly: boolean;
  downSince: number | null;
  reading: Reading | null;
  lastCheckedAt: number | null;
  vantageName: string | null;
  uptime24h: number | null;
  uptime30d: number | null;
  uptime90d: number | null;
  daily90: DayTick[];
  medianLatency24h: number | null;
  lastOutage: { start: number; end: number | null } | null;
};

/** How reachable a domain is, from its automatic monitor. */
export type DomainReachability = {
  domainId: string;
  monitorId: string;
  /** The last check passed; null before one has run. */
  reachable: boolean | null;
  /** The monitor is down: failures confirmed, the way Attention counts them. */
  confirmedUnreachable: boolean;
  lastCheckedAt: number | null;
  statusCode: number | null;
  latencyMs: number | null;
  /** Why the last check failed, in words. */
  error: string | null;
};

export type DomainCheck = { appId: string; at: number; reachable: boolean; responseTimeMs: number };

export type DomainCheckHistory = {
  /** Outcomes before the window, in five-minute slots. */
  prior: { domainId: string; reachable: boolean; n: number }[];
  /** Failed slots inside the window. */
  failures: { domainId: string; domain: string; appId: string; at: number }[];
};

export type RecentDomainCheck = {
  id: string;
  domainId: string;
  reachable: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  error: string | null;
  checkedAt: string;
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

const headerSchema = z.object({ name: z.string().trim().min(1).max(64), value: z.string().max(1024).optional() }).strict();
const basicAuthSchema = z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(500) }).strict();

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
    /** The full set of request headers to keep. A header without a value keeps its stored value. */
    headers: z.array(headerSchema).max(10).optional(),
    basicAuth: basicAuthSchema.optional(),
    shareHeaders: z.boolean().optional(),
    /** Links a manual check to an app, and to one of its domains. */
    appId: z.string().min(1).max(100).optional(),
    domainId: z.string().min(1).max(100).optional(),
  })
  .strict();

export const updateMonitorSchema = createMonitorSchema
  .partial()
  .extend({
    muted: z.boolean().optional(),
    enabled: z.boolean().optional(),
    maintenance: z.array(windowSchema).max(50).optional(),
    /** An automatic monitor's path under its domain. Empty checks the homepage. */
    path: z.string().max(200).optional(),
    /** Clears what was edited on an automatic monitor and runs it as detected. */
    resetOverrides: z.boolean().optional(),
    /** Null clears the keyword. */
    keyword: z.string().trim().max(200).nullable().optional(),
  })
  .strict();

export const reviewAnswerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), status: z.number().int().min(100).max(499) }).strict(),
  z.object({ kind: z.literal("path"), path: z.string().trim().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("skip") }).strict(),
  z.object({ kind: z.literal("headers"), headers: z.array(headerSchema).max(10).optional(), basicAuth: basicAuthSchema.optional(), shareHeaders: z.boolean().optional() }).strict(),
]);

export const detectSchema = z
  .object({ url: httpUrl, headers: z.array(z.object({ name: z.string().trim().min(1).max(64), value: z.string().min(1).max(1024) }).strict()).max(10).optional() })
  .strict();

export const muteSchema = z.object({ muted: z.boolean() }).strict();

export type CreateMonitorInput = z.infer<typeof createMonitorSchema>;
export type UpdateMonitorInput = z.infer<typeof updateMonitorSchema>;
