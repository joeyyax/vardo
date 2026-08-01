// ---------------------------------------------------------------------------
// Activity view — grouping
//
// A flat list repeats the same sentence until the interesting rows are lost in
// it. Adjacent events sharing an action, an actor and an outcome collapse into
// one row: one subject reads as a run, several read as fleet-wide.
// ---------------------------------------------------------------------------

import type {
  ActivityGroup,
  ActivitySubjectRef,
  ClassifiedActivity,
} from "./types";

/** Largest gap between two events that still reads as the same burst. */
export const ADJACENT_GAP_MS = 5 * 60_000;

/** Hard cap on a group's span, so a slow trickle never becomes one row. */
export const MAX_SPAN_MS = 60 * 60_000;

export type GroupOptions = {
  /** Bucket key for the calendar day. Groups never span two day headings. */
  dayKey?: (date: Date) => string;
  adjacentGapMs?: number;
  maxSpanMs?: number;
};

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function actorKey(item: ClassifiedActivity): string {
  return item.user?.id ?? "system";
}

function subjectRef(item: ClassifiedActivity): ActivitySubjectRef {
  return { id: item.subjectId, label: item.subjectLabel, app: item.app };
}

/**
 * Whether `item` belongs in the open bucket. Outcome is part of the identity,
 * so a failure never disappears into a run of successes.
 */
function joins(
  bucket: ClassifiedActivity[],
  item: ClassifiedActivity,
  opts: Required<Omit<GroupOptions, "dayKey">> & { dayKey: (d: Date) => string },
): boolean {
  const head = bucket[0];
  const previous = bucket[bucket.length - 1];

  if (item.action !== head.action) return false;
  if (item.outcome !== head.outcome) return false;
  if (actorKey(item) !== actorKey(head)) return false;
  if (opts.dayKey(item.at) !== opts.dayKey(head.at)) return false;

  // Input is newest first, so time runs backwards through the bucket.
  if (previous.at.getTime() - item.at.getTime() > opts.adjacentGapMs) return false;
  if (head.at.getTime() - item.at.getTime() > opts.maxSpanMs) return false;

  return true;
}

function toGroup(bucket: ClassifiedActivity[]): ActivityGroup {
  const head = bucket[0];
  const tail = bucket[bucket.length - 1];

  const subjects: ActivitySubjectRef[] = [];
  const seen = new Set<string>();
  for (const item of bucket) {
    if (seen.has(item.subjectId)) continue;
    seen.add(item.subjectId);
    subjects.push(subjectRef(item));
  }

  const errors = bucket
    .map((item) => item.error)
    .filter((error): error is string => Boolean(error));

  return {
    id: head.id,
    action: head.action,
    family: head.family,
    outcome: head.outcome,
    actor: head.user,
    subjects,
    count: bucket.length,
    firstAt: tail.at,
    lastAt: head.at,
    error: errors[0],
    errorVariants: new Set(errors).size,
    single: bucket.length === 1 ? head : undefined,
  };
}

/**
 * Collapse a newest-first list into rendered rows. Order is preserved: a group
 * sits where its most recent event sat.
 */
export function groupActivities(
  items: ClassifiedActivity[],
  options: GroupOptions = {},
): ActivityGroup[] {
  const opts = {
    dayKey: options.dayKey ?? localDayKey,
    adjacentGapMs: options.adjacentGapMs ?? ADJACENT_GAP_MS,
    maxSpanMs: options.maxSpanMs ?? MAX_SPAN_MS,
  };

  const groups: ActivityGroup[] = [];
  let bucket: ClassifiedActivity[] = [];

  for (const item of items) {
    if (bucket.length === 0) {
      bucket = [item];
      continue;
    }
    if (joins(bucket, item, opts)) {
      bucket.push(item);
      continue;
    }
    groups.push(toGroup(bucket));
    bucket = [item];
  }

  if (bucket.length) groups.push(toGroup(bucket));
  return groups;
}

export function isFleetWide(group: ActivityGroup): boolean {
  return group.subjects.length > 1;
}
