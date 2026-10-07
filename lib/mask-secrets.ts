/** Prefix marking masked values in transit, so real values starting with "••••" aren't mistaken for masks. */
export const MASK_SENTINEL = "__MASKED__:";

/** Display prefix for masked fields. */
export const MASK_DISPLAY = "••••";

/** Mask a secret for API responses. Null for empty values. */
export function maskSecret(value: string | undefined | null): string | null {
  if (!value) return null;
  const tail = value.length <= 4 ? "" : value.slice(-4);
  return `${MASK_SENTINEL}${tail}`;
}

/** `__MASKED__:ab12` → `••••ab12`. */
export function maskDisplay(value: string | undefined | null): string {
  if (!value) return "";
  if (!value.startsWith(MASK_SENTINEL)) return value;
  return `${MASK_DISPLAY}${value.slice(MASK_SENTINEL.length)}`;
}

/** Whether the value is an unedited masked placeholder. Empty values mean the field was cleared. */
export function isMasked(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  return value.startsWith(MASK_SENTINEL);
}

/** Keep the stored secret when the incoming value is masked; otherwise use the incoming value. */
export function resolveSecret(
  incoming: string | undefined | null,
  existing: string | undefined | null,
): string | undefined {
  if (isMasked(incoming)) return existing ?? undefined;
  return incoming ?? undefined;
}
