// ---------------------------------------------------------------------------
// Activity view — filters and the away window
//
// Filter state lives in the URL so a view can be linked. `since` is the deep
// link "while you were away" uses to answer what happened during an absence.
// ---------------------------------------------------------------------------

import type {
  ActivityFamily,
  ActivityFilters,
  ActivityOutcome,
  ClassifiedActivity,
} from "./types";
import { isFamily, isOutcome } from "./taxonomy";

/** Oldest window the feed will honor. Beyond this the page is a poor archive. */
export const MAX_SINCE_MS = 90 * 24 * 60 * 60_000;

export const EMPTY_FILTERS: ActivityFilters = {
  families: [],
  outcomes: [],
  since: null,
};

/** Accepts one comma-separated value or a repeated param. */
function readList(value: string | string[] | null | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((entry) => entry.split(","))
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * A usable window start, or null. Future timestamps and unparseable input are
 * rejected rather than guessed at; anything older than the cap is clamped.
 */
export function parseSince(
  raw: string | string[] | null | undefined,
  now: Date = new Date(),
): Date | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;

  const parsed = new Date(value);
  const time = parsed.getTime();
  if (Number.isNaN(time)) return null;
  if (time > now.getTime()) return null;

  const floor = now.getTime() - MAX_SINCE_MS;
  return time < floor ? new Date(floor) : parsed;
}

export function parseFamilies(
  raw: string | string[] | null | undefined,
): ActivityFamily[] {
  return unique(readList(raw).filter(isFamily));
}

export function parseOutcomes(
  raw: string | string[] | null | undefined,
): ActivityOutcome[] {
  return unique(readList(raw).filter(isOutcome));
}

type RawParams = Record<string, string | string[] | undefined>;

export function parseFilters(
  params: RawParams,
  now: Date = new Date(),
): ActivityFilters {
  return {
    families: parseFamilies(params.family),
    outcomes: parseOutcomes(params.outcome),
    since: parseSince(params.since, now),
  };
}

/** Round-trips `parseFilters`. Empty values are omitted so URLs stay short. */
export function filtersToQuery(filters: ActivityFilters): string {
  const params = new URLSearchParams();
  if (filters.families.length) params.set("family", filters.families.join(","));
  if (filters.outcomes.length) params.set("outcome", filters.outcomes.join(","));
  if (filters.since) params.set("since", filters.since.toISOString());
  return params.toString();
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value)
    ? list.filter((entry) => entry !== value)
    : [...list, value];
}

/** Next filter state after clicking a family chip. `since` is left alone. */
export function toggleFamily(
  filters: ActivityFilters,
  family: ActivityFamily,
): ActivityFilters {
  return { ...filters, families: toggle(filters.families, family) };
}

export function toggleOutcome(
  filters: ActivityFilters,
  outcome: ActivityOutcome,
): ActivityFilters {
  return { ...filters, outcomes: toggle(filters.outcomes, outcome) };
}

/** Drops family and outcome but keeps the window, so "clear" stays in the window. */
export function clearChips(filters: ActivityFilters): ActivityFilters {
  return { ...filters, families: [], outcomes: [] };
}

export function hasActiveFilters(filters: ActivityFilters): boolean {
  return (
    filters.families.length > 0 ||
    filters.outcomes.length > 0 ||
    filters.since !== null
  );
}

/** An empty family or outcome list means no restriction, not "match nothing". */
export function applyFilters(
  items: ClassifiedActivity[],
  filters: ActivityFilters,
): ClassifiedActivity[] {
  return items.filter((item) => {
    if (filters.families.length && !filters.families.includes(item.family)) {
      return false;
    }
    if (filters.outcomes.length && !filters.outcomes.includes(item.outcome)) {
      return false;
    }
    if (filters.since && item.at < filters.since) return false;
    return true;
  });
}

/** Families actually present, so the UI never offers a filter that finds nothing. */
export function familiesPresent(
  items: ClassifiedActivity[],
): ActivityFamily[] {
  return unique(items.map((item) => item.family));
}

export function countsByOutcome(
  items: ClassifiedActivity[],
): Record<ActivityOutcome, number> {
  const counts: Record<ActivityOutcome, number> = {
    success: 0,
    failure: 0,
    neutral: 0,
  };
  for (const item of items) counts[item.outcome] += 1;
  return counts;
}

/** Rounded duration of an away window, for the header. */
export function describeWindow(since: Date, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - since.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;

  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
