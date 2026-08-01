// ---------------------------------------------------------------------------
// "While you were away" — shared types
//
// The classifier is pure: collectors turn database rows into AwayFact[] plus
// per-subject baselines, and classify() decides what deserves attention.
// ---------------------------------------------------------------------------

export type AwayFamily =
  | "deploy"
  | "backup"
  | "cron"
  | "app"
  | "domain"
  | "security"
  | "system"
  | "org";

export type AwayOutcome = "success" | "failure" | "neutral";

/** One occurrence, normalized across sources. */
export type AwayFact = {
  /** Dot-notation kind. Drives severity, routine membership and grouping. */
  kind: string;
  family: AwayFamily;
  /** Stable id of the thing this happened to — app id, cron job id, domain. */
  subjectId: string;
  subjectName: string;
  at: Date;
  outcome: AwayOutcome;
  detail?: string;
  href?: string;
};

/** Outcome counts for one subject from before the window. */
export type AwayBaseline = {
  successes: number;
  failures: number;
};

/** Keyed `${family}:${subjectId}`. A missing entry means no history. */
export type AwayBaselines = Record<string, AwayBaseline>;

export type AwayInput = {
  since: Date;
  now: Date;
  facts: AwayFact[];
  baselines: AwayBaselines;
  /** Sources that could not be read. Reported rather than silently dropped. */
  unavailable?: string[];
};

/**
 * Why an item is on the list. This is the answer to "do I need to care",
 * so it is rendered, not just used for scoring.
 */
export type AwayReason =
  | "first-failure"
  | "regression"
  | "recurring"
  | "unexplained"
  | "alert"
  | "change"
  | "unrecognized";

export type AwayNotable = {
  id: string;
  kind: string;
  family: AwayFamily;
  subjectId: string;
  subjectName: string;
  reason: AwayReason;
  /** Occurrences collapsed into this row. Never raises score. */
  count: number;
  firstAt: Date;
  lastAt: Date;
  score: number;
  detail?: string;
  href?: string;
};

export type AwayRoutine = {
  family: AwayFamily;
  count: number;
};

export type AwaySummary = {
  since: Date;
  now: Date;
  notable: AwayNotable[];
  routine: AwayRoutine[];
  routineCount: number;
  unavailable: string[];
  /** False when there is nothing worth interrupting for. */
  shouldSurface: boolean;
};
