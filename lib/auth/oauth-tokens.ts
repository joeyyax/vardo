// Encrypts plaintext OAuth tokens on `account` at startup, in Better Auth's format.

import { symmetricEncrypt, type SecretConfig } from "better-auth/crypto";
import { and, eq, ne, or, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { account } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

const log = logger.child("auth");

// XChaCha20-Poly1305: 24-byte nonce plus 16-byte tag, hex-encoded.
const MIN_CIPHERTEXT_HEX = (24 + 16) * 2;

/** Whether Better Auth would read this as ciphertext it wrote. */
export function isOAuthTokenCiphertext(value: string): boolean {
  if (value.startsWith("$ba$")) return true;
  return value.length > MIN_CIPHERTEXT_HEX && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

async function seal(value: string | null, secret: string | SecretConfig): Promise<string | null> {
  if (!value || isOAuthTokenCiphertext(value)) return value;
  return symmetricEncrypt({ key: secret, data: value });
}

/** Encrypts plaintext OAuth tokens. Returns the number of accounts updated. */
export async function encryptStoredOAuthTokens(secret: string | SecretConfig): Promise<number> {
  const rows = await db
    .select({ id: account.id, accessToken: account.accessToken, refreshToken: account.refreshToken })
    .from(account)
    .where(
      and(
        ne(account.providerId, "credential"),
        or(isNotNull(account.accessToken), isNotNull(account.refreshToken)),
      ),
    );

  let updated = 0;
  for (const row of rows) {
    const accessToken = await seal(row.accessToken, secret);
    const refreshToken = await seal(row.refreshToken, secret);
    if (accessToken === row.accessToken && refreshToken === row.refreshToken) continue;
    const result = await db
      .update(account)
      .set({ accessToken, refreshToken, updatedAt: new Date() })
      .where(
        and(
          eq(account.id, row.id),
          row.accessToken === null ? undefined : eq(account.accessToken, row.accessToken),
          row.refreshToken === null ? undefined : eq(account.refreshToken, row.refreshToken),
        ),
      )
      .returning({ id: account.id });
    if (result.length > 0) updated++;
  }

  if (updated > 0) log.info(`Encrypted OAuth tokens on ${updated} account(s)`);
  return updated;
}
