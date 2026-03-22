/**
 * Mask a secret string, showing only the last 4 characters.
 * Returns null for empty/undefined values.
 */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/**
 * Sentinel value used in masked fields. When the client sends back a value
 * starting with this prefix, it means the user didn't edit the field and the
 * server should keep the existing value.
 */
export const MASK_PREFIX = "••••";

/**
 * Returns true if a value is a masked placeholder (not a real secret).
 */
export function isMasked(value: string | undefined | null): boolean {
  if (!value) return true;
  return value.startsWith(MASK_PREFIX);
}
