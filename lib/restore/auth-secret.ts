// Checks BETTER_AUTH_SECRET against a system backup before restoring it: two-factor secrets need it.

import { createReadStream } from "fs";
import { createGunzip } from "zlib";
import { createInterface } from "readline";

export type AuthSecretCheck =
  /** No two-factor secret in the backup, so nothing depends on the auth secret. */
  | { kind: "none" }
  | { kind: "match" }
  /** The backup's two-factor secrets don't open with this instance's BETTER_AUTH_SECRET. */
  | { kind: "mismatch" };

const COPY_LINE = /^COPY public\.two_factor \(([^)]+)\) FROM stdin;$/;

/** The first two-factor secret in a plain pg_dump, or null when there is none. */
export async function findTwoFactorSecret(lines: AsyncIterable<string>): Promise<string | null> {
  let column = -1;
  for await (const line of lines) {
    if (column < 0) {
      const match = line.match(COPY_LINE);
      if (match) {
        column = match[1].split(",").map((c) => c.trim().replace(/"/g, "")).indexOf("secret");
        if (column < 0) return null;
      }
      continue;
    }
    if (line === "\\.") return null;
    const value = line.split("\t")[column];
    return value && value !== "\\N" ? value : null;
  }
  return null;
}

/** Whether `decrypt` opens the backup's two-factor secret. */
export async function checkAuthSecret(
  secret: string | null,
  decrypt: (data: string) => Promise<string>,
): Promise<AuthSecretCheck> {
  if (!secret) return { kind: "none" };
  try {
    await decrypt(secret);
    return { kind: "match" };
  } catch {
    return { kind: "mismatch" };
  }
}

/** Scan a decrypted, gzipped system dump with the running BETTER_AUTH_SECRET. */
export async function checkDumpAuthSecret(dumpPath: string): Promise<AuthSecretCheck> {
  const input = createReadStream(dumpPath).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let secret: string | null;
  try {
    secret = await findTwoFactorSecret(lines);
  } finally {
    lines.close();
    input.destroy();
  }
  const { symmetricDecrypt } = await import("better-auth/crypto");
  const { auth } = await import("@/lib/auth");
  const key = (await auth.$context).secretConfig;
  return checkAuthSecret(secret, (data) => symmetricDecrypt({ key, data }));
}
