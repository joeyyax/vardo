/**
 * Shared cron expression parsing used by both the cron engine and backup scheduler.
 * Supports: minute hour dayOfMonth month dayOfWeek
 * Supports: *, *\/N, N, N-M, N,M
 */

export function shouldRunNow(schedule: string, now: Date): boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const checks = [
    { value: now.getMinutes(), field: parts[0] },
    { value: now.getHours(), field: parts[1] },
    { value: now.getDate(), field: parts[2] },
    { value: now.getMonth() + 1, field: parts[3] },
    { value: now.getDay(), field: parts[4] },
  ];

  return checks.every(({ value, field }) => matchesCronField(value, field));
}

export function matchesCronField(value: number, field: string): boolean {
  if (field === "*") return true;

  // */N — every N
  if (field.startsWith("*/")) {
    const step = parseInt(field.slice(2));
    return value % step === 0;
  }

  // Comma-separated values
  const segments = field.split(",");
  for (const segment of segments) {
    // Range N-M
    if (segment.includes("-")) {
      const [start, end] = segment.split("-").map(Number);
      if (value >= start && value <= end) return true;
    } else {
      if (parseInt(segment) === value) return true;
    }
  }

  return false;
}

export function isSameMinute(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}
