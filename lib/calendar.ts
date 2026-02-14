import ical, { type ParameterValue, type VEvent } from "node-ical";

export type CalendarEvent = {
  id: string;
  title: string;
  start: string; // ISO string
  end: string; // ISO string
  allDay: boolean;
  location?: string;
};

/** Extract the string value from a node-ical ParameterValue (may be plain string or {val, params}). */
function parameterString(value: ParameterValue | undefined): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  return value.val;
}

/**
 * Fetch and parse an ICS feed, returning events within the given date range.
 * Returns empty array on any fetch/parse error (non-blocking).
 */
export async function fetchCalendarEvents(
  icsUrl: string,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<CalendarEvent[]> {
  try {
    const response = await fetch(icsUrl, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "TimeApp/1.0" },
    });

    if (!response.ok) return [];

    const text = await response.text();
    const parsed = ical.parseICS(text);
    const events: CalendarEvent[] = [];

    for (const [uid, component] of Object.entries(parsed)) {
      if (component?.type !== "VEVENT") continue;

      const event = component as VEvent;

      // Expand recurring events into individual instances
      if (event.rrule) {
        const instances = ical.expandRecurringEvent(event, {
          from: rangeStart,
          to: rangeEnd,
        });

        for (const instance of instances) {
          events.push({
            id: `${uid}_${instance.start.toISOString()}`,
            title: parameterString(instance.summary) || "Untitled event",
            start: instance.start.toISOString(),
            end: instance.end.toISOString(),
            allDay: instance.isFullDay,
            location: parameterString(event.location) || undefined,
          });
        }

        continue;
      }

      // Non-recurring event
      const start = event.start;
      const end = event.end ?? start;

      if (start > rangeEnd || end < rangeStart) continue;

      events.push({
        id: uid,
        title: parameterString(event.summary) || "Untitled event",
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: event.datetype === "date",
        location: parameterString(event.location) || undefined,
      });
    }

    events.sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );

    return events;
  } catch {
    // Non-blocking -- calendar failure should not break the dashboard
    return [];
  }
}
