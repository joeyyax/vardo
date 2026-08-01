// ---------------------------------------------------------------------------
// App conditions
//
// apps.status answers what Docker did with the container. Conditions answer how
// a running app is behaving — an app can be active and crash-looping and under
// memory pressure at once, and all three are independently true. The health
// monitor already derived crash-loop, unhealthy and self-heal-exhausted and
// discarded them after firing a notification; this is where they live.
// ---------------------------------------------------------------------------

// Runtime behavior only. Image updates are a 6h-TTL cache keyed off compose
// content, so they do not belong in a 30s tick — the updates API stays the
// source for those and the read path merges them.
export type ConditionKind =
  | "crash-looping"
  | "unhealthy"
  | "self-heal-exhausted"
  | "memory-pressure";

export type ConditionSeverity = "info" | "warning" | "critical";

export type AppCondition = {
  kind: ConditionKind;
  severity: ConditionSeverity;
  /** ISO timestamp of first confirmation, preserved across ticks. */
  since: string;
  detail: string;
};

/** Consecutive samples per kind: positive counts agreeing, negative disagreeing. */
export type ConditionStreaks = Partial<Record<ConditionKind, number>>;

/** Fraction of the memory limit at which an app counts as under pressure. */
export const MEMORY_PRESSURE_RATIO = 0.9;

/**
 * Samples a threshold condition must hold before it is confirmed, and samples it
 * must fail before it clears. Asymmetric on purpose — an app sitting on the line
 * would otherwise flip on every poll and strobe the card. Kinds absent here are
 * discrete facts and switch on the first sample.
 */
export const HYSTERESIS: Partial<Record<ConditionKind, { enter: number; clear: number }>> = {
  "memory-pressure": { enter: 2, clear: 4 },
};

const SEVERITY: Record<ConditionKind, ConditionSeverity> = {
  "crash-looping": "critical",
  "self-heal-exhausted": "critical",
  unhealthy: "warning",
  "memory-pressure": "warning",
};

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
};

/** The raw signal for each kind this tick, before hysteresis. */
function rawSignals(input: ConditionInput): Partial<Record<ConditionKind, string>> {
  const out: Partial<Record<ConditionKind, string>> = {};

  if (input.crashLoop && input.crashLoop.restarts > 0) {
    const mins = Math.max(1, Math.round(input.crashLoop.windowMs / 60_000));
    out["crash-looping"] = `${input.crashLoop.restarts} restarts in ${mins}m, never healthy`;
  }

  if (input.health === "unhealthy") out.unhealthy = "Healthcheck failing";

  if (input.selfHealExhausted) out["self-heal-exhausted"] = "Auto-restart gave up — needs attention";

  if (input.memory && input.memory.limit > 0) {
    const ratio = input.memory.usage / input.memory.limit;
    if (ratio >= MEMORY_PRESSURE_RATIO) {
      out["memory-pressure"] = `${Math.round(ratio * 100)}% of memory limit`;
    }
  }

  return out;
}

/**
 * Confirmed conditions for one app, plus the streak counters to feed back next
 * tick. Pure — the caller owns the streak map.
 */
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
    const detail = raw[kind];
    const active = detail !== undefined;
    const was = prevByKind.get(kind);

    const prior = streaks[kind] ?? 0;
    const streak = active ? Math.max(prior, 0) + 1 : Math.min(prior, 0) - 1;
    nextStreaks[kind] = streak;

    const gate = HYSTERESIS[kind];
    let held: boolean;
    if (!gate) {
      held = active;
    } else if (was) {
      held = streak > -gate.clear;
    } else {
      held = streak >= gate.enter;
    }

    if (!held) continue;
    conditions.push({
      kind,
      severity: SEVERITY[kind],
      since: was?.since ?? new Date(input.now).toISOString(),
      // A condition kept alive by hysteresis reports the reading that confirmed it.
      detail: detail ?? was?.detail ?? "",
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
