// ---------------------------------------------------------------------------
// Whether an available update is one the org asked not to hear about.
//
// A rule targets one app and, for a compose stack, one service: silencing a
// stack because its postgres is pinned would hide the rest of it. An expiry is
// a lapse, not an event — the update simply reappears on the next read.
// ---------------------------------------------------------------------------

export type IgnoreScope = "all" | "major";

export interface IgnoreRule {
  id: string;
  appId: string;
  /** Compose service the rule covers. Null for a single-image app. */
  composeService: string | null;
  scope: IgnoreScope;
  /** ISO timestamp, or null to never lapse. */
  expiresAt: string | null;
}

/** Update the rule is tested against. */
export interface IgnoreCandidate {
  appId: string;
  service: string | null;
  severity: "patch" | "minor" | "major" | "build" | "unknown" | null;
}

export function ruleKey(appId: string, service: string | null): string {
  return `${appId}:${service ?? ""}`;
}

/** A rule that has lapsed is no rule at all. */
export function isActive(rule: IgnoreRule, now: number = Date.now()): boolean {
  if (!rule.expiresAt) return true;
  const expiry = Date.parse(rule.expiresAt);
  return Number.isNaN(expiry) ? true : expiry > now;
}

export function targets(rule: IgnoreRule, candidate: IgnoreCandidate): boolean {
  return (
    rule.appId === candidate.appId &&
    (rule.composeService ?? null) === (candidate.service ?? null)
  );
}

/** Whether this rule hides this update right now. */
export function silences(
  rule: IgnoreRule,
  candidate: IgnoreCandidate,
  now: number = Date.now(),
): boolean {
  if (!targets(rule, candidate) || !isActive(rule, now)) return false;
  return rule.scope === "all" || candidate.severity === "major";
}

/**
 * Index rules by target so a fleet read is one lookup per service rather than
 * a scan of every rule.
 */
export function indexRules(rules: IgnoreRule[]): Map<string, IgnoreRule> {
  return new Map(rules.map((rule) => [ruleKey(rule.appId, rule.composeService), rule]));
}

/** The rule hiding this update, or null when it should surface. */
export function silencedBy(
  index: Map<string, IgnoreRule>,
  candidate: IgnoreCandidate,
  now: number = Date.now(),
): IgnoreRule | null {
  const rule = index.get(ruleKey(candidate.appId, candidate.service));
  return rule && silences(rule, candidate, now) ? rule : null;
}

/** Spans the UI offers, in days. Null is permanent. */
export const IGNORE_DURATIONS: { label: string; days: number | null }[] = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "Forever", days: null },
];

export function expiryFor(days: number | null, from: number = Date.now()): Date | null {
  return days === null ? null : new Date(from + days * 86_400_000);
}

/** Sentence describing a rule, for the ignored list. */
export function describeRule(rule: IgnoreRule, now: number = Date.now()): string {
  const what = rule.scope === "major" ? "Majors hidden" : "All updates hidden";
  if (!rule.expiresAt) return `${what}, permanently`;
  const days = Math.max(0, Math.ceil((Date.parse(rule.expiresAt) - now) / 86_400_000));
  return `${what}, ${days === 0 ? "lapsing today" : `${days} day${days === 1 ? "" : "s"} left`}`;
}
