// Permanent bans store a far-future expiry. Client-safe.

export const PERMANENT_UNTIL = new Date("9999-12-31T00:00:00.000Z");

export function isPermanent(expiresAt: Date | string): boolean {
  const t = new Date(expiresAt).getTime();
  return Number.isFinite(t) && t >= PERMANENT_UNTIL.getTime();
}
