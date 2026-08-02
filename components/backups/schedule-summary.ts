const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function time(hour: string, minute: string): string {
  const h = parseInt(hour, 10);
  const m = parseInt(minute, 10);
  if (Number.isNaN(h) || Number.isNaN(m)) return "";
  const suffix = h < 12 ? "am" : "pm";
  const hh = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hh}${suffix}` : `${hh}:${String(m).padStart(2, "0")}${suffix}`;
}

/**
 * A backup schedule in words. Covers the shapes the scheduler actually writes;
 * anything else falls back to the raw expression rather than guessing.
 */
export function describeSchedule(cron: string | null | undefined): string {
  if (!cron) return "No schedule";
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const at = time(hour, minute);
  if (!at) return cron;

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Daily at ${at}`;

  if (dayOfMonth === "*" && month === "*" && /^[0-6]$/.test(dayOfWeek)) {
    return `Weekly on ${DAYS[parseInt(dayOfWeek, 10)]} at ${at}`;
  }

  if (month === "*" && dayOfWeek === "*" && /^\d{1,2}$/.test(dayOfMonth)) {
    return `Monthly on day ${dayOfMonth} at ${at}`;
  }

  return cron;
}
