// Maintenance window math. Times are wall-clock in the window's zone, so DST shifts with it.

const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes after midnight for `HH:MM`, or null. */
export function parseClock(value: string): number | null {
  const m = CLOCK_RE.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes after local midnight in `tz`. */
export function localMinutes(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

export type WindowSpec = { start: string; end: string };

/** Whether `now` falls in the window. An end before the start runs past midnight; equal ends mean all day. */
export function inWindow(now: Date, window: WindowSpec, tz: string): boolean {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === null || end === null) return false;
  if (start === end) return true;
  const m = localMinutes(now, tz);
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The next minute the window opens, within two days. Null when it's open now or never opens. */
export function nextWindowOpen(now: Date, window: WindowSpec, tz: string): Date | null {
  if (inWindow(now, window, tz)) return null;
  const first = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  for (let i = 0; i <= 2 * 24 * 60; i++) {
    const t = new Date(first.getTime() + i * 60_000);
    if (inWindow(t, window, tz)) return t;
  }
  return null;
}

/** The window's zone: its own, then the instance's, then UTC. */
export function windowZone(windowTz: string | null, instanceTz: string | null): string {
  if (windowTz && isValidTimeZone(windowTz)) return windowTz;
  if (instanceTz && isValidTimeZone(instanceTz)) return instanceTz;
  return "UTC";
}
