// Plain data shapes for the uptime core. Imports nothing from Vardo.

export type Owner = { kind: "org"; orgId: string } | { kind: "instance" };

export const INTERVALS = [30, 60, 300] as const;
export type IntervalSec = (typeof INTERVALS)[number];
export const DEFAULT_INTERVAL: IntervalSec = 60;

export type HttpCheck = {
  type: "http";
  url: string;
  /** Inclusive status range. */
  expectedStatus: { min: number; max: number };
  keyword?: string;
  timeoutMs: number;
  /** Set at run time from the monitor's encrypted headers. Never stored with the check. */
  headers?: Record<string, string>;
};
export type TcpCheck = { type: "tcp"; host: string; port: number; timeoutMs?: number };
export type TlsCheck = { type: "tls"; host: string; port: number; warnDays: number; timeoutMs?: number };
export type Check = HttpCheck | TcpCheck | TlsCheck;

export const DEFAULT_EXPECTED_STATUS = { min: 200, max: 399 } as const;
/** Automatic monitors count any response below 500 as up: an API that answers 404 at / is still serving. */
export const AUTO_EXPECTED_STATUS = { min: 100, max: 499 } as const;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_TLS_PORT = 443;
export const DEFAULT_TLS_WARN_DAYS = 14;

/** Fields the operator changed on an automatic monitor. Sync and detection leave them alone until reset. */
export type AutoOverrides = {
  name?: string;
  /** Path under the domain. An empty string checks the homepage. */
  path?: string;
  expectedStatus?: { min: number; max: number };
  keyword?: string;
  timeoutMs?: number;
  intervalSec?: IntervalSec;
};

/** What the operator said about an automatic monitor that answers below 500 but not 2xx. */
export type ReviewAnswer =
  /** This status is what the app answers when up. */
  | { kind: "status"; status: number }
  /** Check this path instead. */
  | { kind: "path"; path: string }
  /** Don't monitor this domain. */
  | { kind: "skip" };

export type MaintenanceWindow = { start: number; end: number };

export type Monitor = {
  id: string;
  owner: Owner;
  name: string;
  check: Check;
  intervalSec: IntervalSec;
  muted: boolean;
  enabled: boolean;
  source: "auto" | "manual";
  appId?: string;
  domainId?: string;
  /** Auto monitor of a preview environment. */
  preview?: boolean;
  maintenance?: MaintenanceWindow[];
};

/** Why a check failed. Never a raw error string or response body. */
export const ERROR_KINDS = [
  "timeout",
  "dns",
  "refused",
  "reset",
  "tls",
  "cert-expired",
  "cert-expiring",
  "status",
  "keyword",
  "invalid",
  "private-address",
  "blocked",
  "unknown",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** The route a check took: the internet, a linked instance's WireGuard tunnel, or this instance. */
export const CHECK_PATHS = ["public", "mesh", "local"] as const;
export type CheckPath = (typeof CHECK_PATHS)[number];

/** A check a prober runs for another instance's monitor. `path` defaults to public. */
export type WatchEntry = {
  monitorId: string;
  check: Check;
  intervalSec: IntervalSec;
  path?: "public" | "mesh";
  /** Request headers the owner chose to share with linked instances. */
  headers?: Record<string, string>;
  /** How often to run it: the interval times the vantage points sharing the monitor. Defaults to `intervalSec`. */
  periodSec?: number;
  /** When in the period to run it, in ms from the epoch's period boundary. */
  offsetMs?: number;
};

/** A result that says nothing about the target, such as a check skipped for a private address or refused by the outbound policy. It counts as no data. */
export function isUnknownResult(r: Pick<CheckResult, "error">): boolean {
  return r.error === "private-address" || r.error === "blocked";
}

export type CheckResult = {
  monitorId: string;
  vantageId: string;
  /** The route the check took. */
  path: CheckPath;
  /** Epoch milliseconds when the check started. */
  at: number;
  ok: boolean;
  latencyMs: number;
  /** HTTP status, when a response came back. */
  status?: number;
  error?: ErrorKind;
  /** Whole days until the certificate expires, on TLS checks that read one. */
  certDaysLeft?: number;
};

export type VantagePoint = {
  id: string;
  name: string;
  kind: "local" | "external";
  location?: string;
};

export type VantageState = "up" | "failing" | "unknown";
/** `degraded`: the vantage points that decide split, or one that doesn't decide disagrees. */
export type MonitorState = "up" | "degraded" | "down" | "unknown";

/** Why vantage points disagree, when they do. */
export type Reading =
  /** Public checks fail while local or mesh checks succeed: DNS, certificate, CDN or firewall. */
  | { kind: "unreachable-outside" }
  /** The mesh check fails while the local one succeeds: the link or the peer. */
  | { kind: "unreachable-mesh" }
  /** The local check fails while the others succeed. */
  | { kind: "local-only" }
  /** Some vantage points fail while the rest succeed. */
  | { kind: "vantage-failing"; vantages: string[] };

export type VantageStatus = {
  vantage: VantagePoint;
  path: CheckPath;
  state: VantageState;
  last?: CheckResult;
  /** Epoch ms the current run of the same outcome began. */
  since?: number;
};

export type Evaluation = {
  state: MonitorState;
  /** Only the local vantage point decided. */
  localOnly: boolean;
  vantages: VantageStatus[];
  /** Epoch ms the monitor went down, when it's down. */
  downSince?: number;
  reading?: Reading;
};

/** Minutes of one bucket, by outcome. */
export type Bucket = {
  /** Epoch ms of the bucket start. */
  start: number;
  minutesUp: number;
  minutesDown: number;
  minutesUnknown: number;
  /** Two decimals; null when nothing in the bucket is known. */
  uptimePct: number | null;
  medianLatencyMs: number | null;
};
