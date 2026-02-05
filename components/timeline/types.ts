/**
 * Types for timeline components
 */

/**
 * Time entry with flexible hierarchy.
 * Entries can be assigned at any level:
 * - Client only (project and task are null)
 * - Client + Project (task is null)
 * - Client + Project + Task (full hierarchy)
 */
export interface TimeEntry {
  id: string;
  description: string | null;
  date: string; // YYYY-MM-DD
  durationMinutes: number;
  isBillableOverride: boolean | null;
  isBillable: boolean;
  recurringTemplateId: string | null;
  createdAt: string;
  client: {
    id: string;
    name: string;
    color: string | null;
  };
  project: {
    id: string;
    name: string;
    code: string | null;
  } | null;
  task: {
    id: string;
    name: string;
  } | null;
}

export interface DayGroup {
  date: string;
  entries: TimeEntry[];
  totalMinutes: number;
}

export interface WeekRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  label: string; // e.g., "Jan 27 - Feb 2"
}
