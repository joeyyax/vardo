/**
 * Types for timeline components
 */

export interface TimeEntry {
  id: string;
  description: string | null;
  date: string; // YYYY-MM-DD
  durationMinutes: number;
  isBillableOverride: boolean | null;
  isBillable: boolean;
  createdAt: string;
  task: {
    id: string;
    name: string;
    project: {
      id: string;
      name: string;
      code: string | null;
      client: {
        id: string;
        name: string;
        color: string | null;
      };
    };
  };
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
