// ---------------------------------------------------------------------------
// Activity view — shared types
//
// The feed is built from pure functions: taxonomy classifies a raw row, filter
// narrows the set, group collapses repeats. Components render the result.
// ---------------------------------------------------------------------------

import type { AwayFamily, AwayOutcome } from "@/lib/away/types";

/** Families are shared with "while you were away" so the two surfaces agree. */
export type ActivityFamily = AwayFamily;
export type ActivityOutcome = AwayOutcome;

export type ActivityActor = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

export type ActivitySubject = {
  id: string;
  name: string;
  displayName: string;
};

/** One row as it comes out of the database. */
export type ActivityRow = {
  id: string;
  action: string;
  metadata: unknown;
  createdAt: Date | string;
  user: ActivityActor | null;
  app: ActivitySubject | null;
};

/** A row plus everything the taxonomy derived from it. */
export type ClassifiedActivity = ActivityRow & {
  family: ActivityFamily;
  outcome: ActivityOutcome;
  at: Date;
  /** Stable id of the thing acted on. Falls back to the action when appId is null. */
  subjectId: string;
  subjectLabel: string;
  /** Failure text pulled out of metadata, already trimmed to one line. */
  error?: string;
};

/** One thing an action was performed on. */
export type ActivitySubjectRef = {
  id: string;
  label: string;
  /** Present while the subject is still a live app, so the row can link to it. */
  app: ActivitySubject | null;
};

/**
 * One rendered row. Either a single event, a run of the same event on one
 * subject, or one action fanned out across several subjects.
 */
export type ActivityGroup = {
  id: string;
  action: string;
  family: ActivityFamily;
  outcome: ActivityOutcome;
  actor: ActivityActor | null;
  /** Distinct subjects, newest first. Length > 1 means fleet-wide. */
  subjects: ActivitySubjectRef[];
  /** Events collapsed into this row. */
  count: number;
  firstAt: Date;
  lastAt: Date;
  /** Most recent failure text across the collapsed events. */
  error?: string;
  /** Distinct failure texts seen, when a run failed more than one way. */
  errorVariants: number;
  /** The single underlying event, present only when count is 1. */
  single?: ClassifiedActivity;
};

export type ActivityFilters = {
  families: ActivityFamily[];
  outcomes: ActivityOutcome[];
  since: Date | null;
};
