// App conditions: how a running app is behaving, independent of apps.status.

import {
  CERT_EXPIRY_CRITICAL_DAYS,
  CERT_EXPIRY_THRESHOLD_DAYS,
} from "@/lib/system-alerts/cert-expiry";

// Runtime behavior only; image updates are merged in on read.
export type ConditionKind =
  | "crash-looping"
  | "unhealthy"
  | "self-heal-exhausted"
  | "memory-pressure"
  | "security-findings"
  | "backup-missing"
  | "backup-stale"
  | "cert-expiring"
  | "cert-expired";

export type ConditionSeverity = "info" | "warning" | "critical";

export type AppCondition = {
  kind: ConditionKind;
  severity: ConditionSeverity;
  /** ISO timestamp of first confirmation, preserved across ticks. */
  since: string;
  detail: string;
};

/** Evaluator state for one kind, carried between ticks by the caller. */
export type ConditionStreak = {
  /** Consecutive samples: positive counts agreeing, negative disagreeing. */
  streak: number;
  /** Epoch ms the current agreeing run began. Undefined while the signal is off. */
  activeSince?: number;
};

export type ConditionStreaks = Partial<Record<ConditionKind, ConditionStreak>>;

/** Fraction of the memory limit at which an app counts as under pressure. */
export const MEMORY_PRESSURE_RATIO = 0.9;

/** How long a container must stay over MEMORY_PRESSURE_RATIO to count as sustained. */
export const MEMORY_PRESSURE_SUSTAINED_MS = 10 * 60_000;

/** Time to confirm and failed samples to clear per threshold kind. Absent kinds switch on the first sample. */
export const HYSTERESIS: Partial<Record<ConditionKind, { sustainedMs: number; clear: number }>> = {
  "memory-pressure": { sustainedMs: MEMORY_PRESSURE_SUSTAINED_MS, clear: 4 },
};

const SEVERITY: Record<ConditionKind, ConditionSeverity> = {
  "crash-looping": "critical",
  "self-heal-exhausted": "critical",
  unhealthy: "warning",
  "memory-pressure": "warning",
  "security-findings": "warning",
  "backup-missing": "warning",
  "backup-stale": "warning",
  "cert-expiring": "warning",
  "cert-expired": "critical",
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The backup-stale detail for a job that has never captured anything. */
export const BACKUP_NEVER_RAN_DETAIL = "Backup job has never run";

/** A backup that has not run in this long is overdue regardless of schedule. */
export const BACKUP_STALE_MS = 48 * 60 * 60 * 1000;

/** A certificate observation older than this is treated as unknown. */
export const CERT_OBSERVATION_STALE_MS = 24 * 60 * 60 * 1000;

const SEVERITY_RANK: Record<ConditionSeverity, number> = { critical: 0, warning: 1, info: 2 };

export type ConditionInput = {
  now: number;
  /** Restart activity since the monitor's baseline, null when not tracked yet. */
  crashLoop: { restarts: number; windowMs: number } | null;
  /** Docker healthcheck state, null when the image declares no healthcheck. */
  health: "healthy" | "unhealthy" | "starting" | null;
  /** Auto-restart hit its cap without the container recovering. */
  selfHealExhausted: boolean;
  /** Live usage against the container's cgroup limit. Limit 0 means unlimited. */
  memory: { usage: number; limit: number } | null;
  /** Latest completed security scan, null when the app has never been scanned. */
  security: { critical: number; warning: number } | null;
  /** Backup coverage. Null when backup state was not loaded this tick. */
  backup: { hasVolumes: boolean; configured: boolean; lastRunAt: number | null } | null;
  /** Soonest certificate expiry across the app's domains. Null when unknown. */
  cert: { domain: string; expiresAt: number; checkedAt: number } | null;
};

/** A signal with optional severity override. `active: false` is a non-fault reading for a held condition's detail. */
type Signal = { detail: string; severity?: ConditionSeverity; active?: boolean };

/** The raw signal for each kind this tick, before hysteresis. */
function rawSignals(input: ConditionInput): Partial<Record<ConditionKind, Signal>> {
  const out: Partial<Record<ConditionKind, Signal>> = {};

  if (input.crashLoop && input.crashLoop.restarts > 0) {
    const mins = Math.max(1, Math.round(input.crashLoop.windowMs / 60_000));
    out["crash-looping"] = {
      detail: `${input.crashLoop.restarts} restarts in ${mins}m, never healthy`,
    };
  }

  if (input.health === "unhealthy") out.unhealthy = { detail: "Healthcheck failing" };

  if (input.selfHealExhausted) {
    out["self-heal-exhausted"] = { detail: "Auto-restart gave up — needs attention" };
  }

  if (input.memory && input.memory.limit > 0) {
    const ratio = input.memory.usage / input.memory.limit;
    const over = ratio >= MEMORY_PRESSURE_RATIO;
    const pct = `${Math.round(ratio * 100)}% of memory limit`;
    out["memory-pressure"] = { detail: over ? pct : `${pct}, easing`, active: over };
  }

  if (input.security && (input.security.critical > 0 || input.security.warning > 0)) {
    const { critical, warning } = input.security;
    out["security-findings"] =
      critical > 0
        ? {
            detail: `${critical} critical finding${critical === 1 ? "" : "s"}`,
            severity: "critical",
          }
        : { detail: `${warning} warning${warning === 1 ? "" : "s"}` };
  }

  // Only apps with persistent data need a backup.
  if (input.backup?.hasVolumes && !input.backup.configured) {
    out["backup-missing"] = { detail: "No backup job covers this app" };
  }

  if (input.backup?.configured) {
    const { lastRunAt } = input.backup;
    if (lastRunAt === null) {
      out["backup-stale"] = { detail: BACKUP_NEVER_RAN_DETAIL };
    } else if (input.now - lastRunAt > BACKUP_STALE_MS) {
      const days = Math.floor((input.now - lastRunAt) / MS_PER_DAY);
      out["backup-stale"] = { detail: `Last backup ${days} day${days === 1 ? "" : "s"} ago` };
    }
  }

  const cert = certSignal(input);
  if (cert) out[cert.kind] = cert.signal;

  return out;
}

/** Expiry verdict for the app's soonest-expiring certificate. */
function certSignal(
  input: ConditionInput,
): { kind: "cert-expiring" | "cert-expired"; signal: Signal } | null {
  const cert = input.cert;
  if (!cert) return null;
  if (input.now - cert.checkedAt > CERT_OBSERVATION_STALE_MS) return null;

  if (cert.expiresAt <= input.now) {
    const days = Math.floor((input.now - cert.expiresAt) / MS_PER_DAY);
    return {
      kind: "cert-expired",
      signal: {
        detail:
          days === 0
            ? `${cert.domain} certificate has expired`
            : `${cert.domain} certificate expired ${days} day${days === 1 ? "" : "s"} ago`,
      },
    };
  }

  const daysLeft = Math.floor((cert.expiresAt - input.now) / MS_PER_DAY);
  if (daysLeft > CERT_EXPIRY_THRESHOLD_DAYS) return null;

  return {
    kind: "cert-expiring",
    signal: {
      detail:
        daysLeft === 0
          ? `${cert.domain} certificate expires within a day`
          : `${cert.domain} certificate expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      severity: daysLeft <= CERT_EXPIRY_CRITICAL_DAYS ? "critical" : undefined,
    },
  };
}

/** Confirmed conditions for one app and the streaks to pass back next tick. */
export function evaluateConditions(
  input: ConditionInput,
  prev: AppCondition[],
  streaks: ConditionStreaks,
): { conditions: AppCondition[]; streaks: ConditionStreaks } {
  const raw = rawSignals(input);
  const prevByKind = new Map(prev.map((c) => [c.kind, c]));
  const nextStreaks: ConditionStreaks = {};
  const conditions: AppCondition[] = [];

  for (const kind of Object.keys(SEVERITY) as ConditionKind[]) {
    const signal = raw[kind];
    const active = signal !== undefined && signal.active !== false;
    const was = prevByKind.get(kind);

    const prior = streaks[kind];
    const streak = active
      ? Math.max(prior?.streak ?? 0, 0) + 1
      : Math.min(prior?.streak ?? 0, 0) - 1;
    const activeSince = active ? (prior?.activeSince ?? input.now) : undefined;
    nextStreaks[kind] = { streak, activeSince };

    const gate = HYSTERESIS[kind];
    let held: boolean;
    if (!gate) {
      held = active;
    } else if (was) {
      held = streak > -gate.clear;
    } else {
      held = activeSince !== undefined && input.now - activeSince >= gate.sustainedMs;
    }

    if (!held) continue;
    conditions.push({
      kind,
      severity: signal?.severity ?? SEVERITY[kind],
      // Dates from when the reading crossed, not when it was confirmed.
      since: was?.since ?? new Date(activeSince ?? input.now).toISOString(),
      // Only a tick with no reading at all falls back to the confirming one.
      detail: signal?.detail ?? was?.detail ?? "",
    });
  }

  conditions.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  return { conditions, streaks: nextStreaks };
}

/** Highest severity present, for a card that shows one line. */
export function worstCondition(conditions: AppCondition[]): AppCondition | null {
  if (conditions.length === 0) return null;
  return conditions.reduce((worst, c) =>
    SEVERITY_RANK[c.severity] < SEVERITY_RANK[worst.severity] ? c : worst,
  );
}

/** Whether two condition sets differ in anything worth a database write. */
export function conditionsEqual(a: AppCondition[], b: AppCondition[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c, i) => {
    const o = b[i];
    return c.kind === o.kind && c.severity === o.severity && c.detail === o.detail;
  });
}
