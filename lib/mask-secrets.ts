/**
 * Unique sentinel prefix used to identify masked values in transit.
 * The UI displays a friendly "••••" to the user, but the actual value sent
 * over the wire uses this unambiguous prefix so real passwords starting
 * with "••••" are never misidentified.
 */
export const MASK_SENTINEL = "__MASKED__:";

/**
 * Display prefix shown to users in the UI for masked fields.
 */
export const MASK_DISPLAY = "••••";

/**
 * Mask a secret string for API responses.
 * Returns `null` for empty/undefined values.
 * The returned value uses the sentinel prefix so the server can recognise
 * untouched fields on save.
 */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  const tail = value.length <= 4 ? "" : value.slice(-4);
  return `${MASK_SENTINEL}${tail}`;
}

/**
 * Convert a sentinel-prefixed masked value to a user-friendly display string.
 * Example: `__MASKED__:ab12` → `••••ab12`
 */
export function maskDisplay(value: string | undefined | null): string {
  if (!value) return "";
  if (!value.startsWith(MASK_SENTINEL)) return value;
  return `${MASK_DISPLAY}${value.slice(MASK_SENTINEL.length)}`;
}

/**
 * Returns `true` only when the value is a sentinel-prefixed masked
 * placeholder — meaning the user did not edit the field.
 *
 * Empty string, `null`, and `undefined` return `false` (the user
 * cleared the field intentionally).
 */
export function isMasked(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith(MASK_SENTINEL);
}
