// ---------------------------------------------------------------------------
// "While you were away" — classification
//
// Two tiers. Routine is an allowlist of successful automated work; everything
// else is worth a look, including kinds this module does not recognize. Tier is
// categorical and score only orders the list, so a failure can never be scored
// down into silence.
// ---------------------------------------------------------------------------

import type {
  AwayBaseline,
  AwayBaselines,
  AwayFact,
  AwayFamily,
  AwayInput,
  AwayNotable,
  AwayReason,
  AwayRoutine,
  AwaySummary,
} from "./types";

/** The platform working. Anything absent from this set gets a look. */
export const ROUTINE_KINDS = new Set([
  "deploy.success",
  "deploy.cancelled",
  "backup.success",
  "cron.success",
  "app.restart-expected",
  "domain.reachable",
  "org.invitation-sent",
  "org.invitation-accepted",
  "system.update-available",
]);

/** Kinds with no success denominator — judged on severity, not track record. */
const ALERT_KINDS = new Set([
  "disk.write-alert",
  "volume.drift",
  "security.file-exposed",
  "security.scan-findings",
]);

/** State changes the platform cannot account for. */
export const UNEXPLAINED_KINDS = new Set([
  "app.down-unexplained",
  "app.stopped-unexplained",
  "app.restarted-unexplained",
  "app.broke-after-deploy",
]);

const SEVERITY: Record<string, number> = {
  "security.file-exposed": 60,
  "system.service-down": 60,
  "system.disk-alert-critical": 58,
  "app.broke-after-deploy": 55,
  "app.down-unexplained": 52,
  "security.scan-findings": 50,
  "system.restart-loop": 48,
  "app.gave-up-restarting": 48,
  "system.cert-expiring": 45,
  "backup.failed": 45,
  "system.host-restarted": 45,
  "domain.unreachable": 42,
  "deploy.failed": 40,
  "system.disk-alert": 40,
  "app.stopped-unexplained": 38,
  "cron.failed": 35,
  "deploy.rollback": 30,
  "app.restarted-unexplained": 28,
  "volume.drift": 24,
  "disk.write-alert": 24,
};

/** Unrecognized kinds land mid-list — visible, not shouting. */
const DEFAULT_SEVERITY = 20;

const REASON_BONUS: Record<AwayReason, number> = {
  "first-failure": 25,
  regression: 15,
  unexplained: 15,
  alert: 0,
  change: 0,
  unrecognized: 0,
  recurring: 0,
};

/** At or above this share of prior runs failing, the failure is expected. */
export const RECURRING_FAILURE_RATE = 0.34;

/** Extra demotion once something is established as flaky. */
const RECURRING_PENALTY = 10;

/**
 * Minimum absence before a summary is worth showing. Below this the SSE
 * catch-up window and live toasts already covered the gap.
 */
export const MIN_AWAY_MS = 15 * 60_000;

export function baselineKey(family: AwayFamily, subjectId: string): string {
  return `${family}:${subjectId}`;
}

function lookupBaseline(
  baselines: AwayBaselines,
  fact: AwayFact,
): AwayBaseline | undefined {
  return baselines[baselineKey(fact.family, fact.subjectId)];
}

/**
 * Why this item needs a look. Failures are graded against the subject's own
 * history: never failed before outranks normally-fine, which outranks flaky.
 */
export function reasonFor(
  fact: AwayFact,
  baseline: AwayBaseline | undefined,
): AwayReason {
  if (UNEXPLAINED_KINDS.has(fact.kind)) return "unexplained";
  if (ALERT_KINDS.has(fact.kind) || fact.family === "system") return "alert";

  if (fact.outcome === "failure") {
    const failures = baseline?.failures ?? 0;
    const total = (baseline?.successes ?? 0) + failures;
    if (failures === 0) return "first-failure";
    if (failures / total >= RECURRING_FAILURE_RATE) return "recurring";
    return "regression";
  }

  // Someone else changed something. Not a fault, still worth knowing.
  if (fact.family === "org") return "change";

  return "unrecognized";
}

/**
 * Ordering weight. Frequency only ever subtracts: a familiar failure sinks
 * below a first-time one, and repeats inside the window add nothing.
 */
export function scoreFor(
  fact: AwayFact,
  reason: AwayReason,
  baseline: AwayBaseline | undefined,
): number {
  const severity = SEVERITY[fact.kind] ?? DEFAULT_SEVERITY;
  const priorFailures = baseline?.failures ?? 0;
  const priorSuccesses = baseline?.successes ?? 0;

  // A subject with a long clean record breaking is worse than a new one.
  const trackRecord =
    reason === "first-failure" || reason === "regression"
      ? Math.min(priorSuccesses, 50) / 5
      : 0;

  const familiarity = Math.min(priorFailures, 20) / 2;
  const recurring = reason === "recurring" ? RECURRING_PENALTY : 0;

  return (
    severity + REASON_BONUS[reason] + trackRecord - familiarity - recurring
  );
}

function isRoutine(fact: AwayFact): boolean {
  return ROUTINE_KINDS.has(fact.kind) && fact.outcome !== "failure";
}

/**
 * Split the window into routine and worth-a-look, collapsing repeats.
 * Notable rows group by kind and subject; routine collapses to family counts.
 */
export function classifyAway(input: AwayInput): AwaySummary {
  const { since, now, facts, baselines, unavailable = [] } = input;

  const routineCounts = new Map<AwayFamily, number>();
  const groups = new Map<string, AwayNotable>();

  for (const fact of facts) {
    if (isRoutine(fact)) {
      routineCounts.set(fact.family, (routineCounts.get(fact.family) ?? 0) + 1);
      continue;
    }

    const key = `${fact.kind}:${fact.subjectId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (fact.at < existing.firstAt) existing.firstAt = fact.at;
      if (fact.at > existing.lastAt) {
        existing.lastAt = fact.at;
        existing.detail = fact.detail ?? existing.detail;
      }
      continue;
    }

    const baseline = lookupBaseline(baselines, fact);
    const reason = reasonFor(fact, baseline);
    groups.set(key, {
      id: key,
      kind: fact.kind,
      family: fact.family,
      subjectId: fact.subjectId,
      subjectName: fact.subjectName,
      reason,
      count: 1,
      firstAt: fact.at,
      lastAt: fact.at,
      score: scoreFor(fact, reason, baseline),
      detail: fact.detail,
      href: fact.href,
    });
  }

  const notable = [...groups.values()].sort(
    (a, b) =>
      b.score - a.score ||
      b.lastAt.getTime() - a.lastAt.getTime() ||
      a.subjectName.localeCompare(b.subjectName),
  );

  const routine: AwayRoutine[] = [...routineCounts.entries()]
    .map(([family, count]) => ({ family, count }))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family));

  return {
    since,
    now,
    notable,
    routine,
    routineCount: routine.reduce((sum, r) => sum + r.count, 0),
    unavailable,
    // Nothing needed a look means nothing worth interrupting for. Successful
    // work alone is not news, so the surface stays hidden.
    shouldSurface:
      notable.length > 0 && now.getTime() - since.getTime() >= MIN_AWAY_MS,
  };
}
