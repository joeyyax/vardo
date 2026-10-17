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
};
export type TcpCheck = { type: "tcp"; host: string; port: number; timeoutMs?: number };
export type TlsCheck = { type: "tls"; host: string; port: number; warnDays: number; timeoutMs?: number };
export type Check = HttpCheck | TcpCheck | TlsCheck;

export const DEFAULT_EXPECTED_STATUS = { min: 200, max: 399 } as const;
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
export const DEFAULT_TLS_PORT = 443;
export const DEFAULT_TLS_WARN_DAYS = 14;

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

/** A check a prober runs for another instance's monitor. */
export type WatchEntry = { monitorId: string; check: Check; intervalSec: IntervalSec };

/** A result that says nothing about the target, such as a check skipped for a private address or refused by the outbound policy. It counts as no data. */
export function isUnknownResult(r: Pick<CheckResult, "error">): boolean {
  return r.error === "private-address" || r.error === "blocked";
}

export type CheckResult = {
  monitorId: string;
  vantageId: string;
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
export type MonitorState = "up" | "down" | "unknown";

export type VantageStatus = {
  vantage: VantagePoint;
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
