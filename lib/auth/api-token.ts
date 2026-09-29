import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiTokens } from "@/lib/db/schema";

export type ApiTokenRow = {
  id: string;
  userId: string;
  organizationId: string;
  crossOrg: boolean;
  expiresAt: Date | null;
};

/** The scope a token carries, or will carry once minted. */
export type TokenScope = {
  crossOrg: boolean;
  expiresAt: Date | null;
};

export function hashApiToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export function isTokenExpired(token: { expiresAt: Date | null }, now = new Date()): boolean {
  return token.expiresAt != null && token.expiresAt.getTime() <= now.getTime();
}

/** Look up a raw bearer token. Null when unknown or expired. */
export async function findApiToken(rawToken: string): Promise<ApiTokenRow | null> {
  if (!rawToken) return null;
  const token = await db.query.apiTokens.findFirst({
    where: eq(apiTokens.tokenHash, hashApiToken(rawToken)),
    columns: {
      id: true,
      userId: true,
      organizationId: true,
      crossOrg: true,
      expiresAt: true,
    },
  });
  if (!token || isTokenExpired(token)) return null;
  return token;
}

/**
 * Why `requested` exceeds what the caller may grant, or null when it fits.
 * `caller` is the token making the request; null for a cookie session.
 */
export function scopeCeilingViolation(opts: {
  caller: TokenScope | null;
  requested: Partial<TokenScope>;
}): string | null {
  const { caller, requested } = opts;

  if (requested.crossOrg && caller && !caller.crossOrg) {
    return "A token cannot grant access to organizations it cannot reach";
  }
  if (caller?.expiresAt) {
    if (requested.expiresAt === undefined) return null;
    if (requested.expiresAt === null || requested.expiresAt > caller.expiresAt) {
      return "A token cannot outlive the token that minted it";
    }
  }
  return null;
}
