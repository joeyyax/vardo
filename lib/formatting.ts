/**
 * Shared formatting utilities.
 *
 * Consolidates formatCurrency, formatHours, formatDuration, etc. that were
 * previously copy-pasted across 30+ files.
 */

/**
 * Format cents as USD currency string.
 * @example formatCurrency(1250) → "$12.50"
 */
export function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

/**
 * Format minutes as decimal hours.
 * @param precision — decimal places (default 2)
 * @example formatHoursDecimal(90) → "1.50"
 * @example formatHoursDecimal(90, 1) → "1.5"
 */
export function formatHoursDecimal(
  minutes: number,
  precision: number = 2
): string {
  return (minutes / 60).toFixed(precision);
}

/**
 * Format minutes as human-readable hours string.
 * @example formatHoursHuman(90) → "1h 30m"
 * @example formatHoursHuman(120) → "2h"
 * @example formatHoursHuman(0) → "0h"
 */
export function formatHoursHuman(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  if (hours === 0) return `${mins}m`;
  return `${hours}h ${mins}m`;
}

/**
 * Format minutes as "H:MM" duration.
 * @example formatDuration(90) → "1:30"
 * @example formatDuration(5) → "0:05"
 */
export function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}:${mins.toString().padStart(2, "0")}`;
}

/**
 * Parse a duration string into minutes.
 * Supports: "1:30" (H:MM), "1h30m", "1.5h", "90m", "1.5" (decimal hours).
 * @example parseDurationMinutes("1:30") → 90
 * @example parseDurationMinutes("1.5h") → 90
 * @example parseDurationMinutes("90m") → 90
 * @example parseDurationMinutes("1.5") → 90
 */
export function parseDurationMinutes(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  // Format: 1:30 (hours:minutes)
  const colonMatch = trimmed.match(/^(\d+):(\d{1,2})$/);
  if (colonMatch) {
    const hours = parseInt(colonMatch[1], 10);
    const minutes = parseInt(colonMatch[2], 10);
    if (minutes > 59) return null;
    return hours * 60 + minutes;
  }

  // Format: 1h30m or 1h 30m
  const hoursMinutesMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*h(?:ours?)?\s*(\d+)?\s*m?(?:in(?:ute)?s?)?$/
  );
  if (hoursMinutesMatch) {
    const hours = parseFloat(hoursMinutesMatch[1]);
    const minutes = hoursMinutesMatch[2]
      ? parseInt(hoursMinutesMatch[2], 10)
      : 0;
    return Math.round(hours * 60) + minutes;
  }

  // Format: 1.5h or 1h
  const hoursMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*h(?:ours?)?$/);
  if (hoursMatch) {
    return Math.round(parseFloat(hoursMatch[1]) * 60);
  }

  // Format: 90m or 90min
  const minutesMatch = trimmed.match(/^(\d+)\s*m(?:in(?:ute)?s?)?$/);
  if (minutesMatch) {
    return parseInt(minutesMatch[1], 10);
  }

  // Format: bare number (assume decimal hours)
  const numberMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (numberMatch) {
    return Math.round(parseFloat(numberMatch[1]) * 60);
  }

  return null;
}
