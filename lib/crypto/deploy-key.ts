import { db } from "@/lib/db";
import { deployKeys } from "@/lib/db/schema";
import { decrypt, isEncrypted } from "@/lib/crypto/encrypt";
import { eq } from "drizzle-orm";
import { writeFile, unlink, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";

/** Decrypted PEM private key for a deploy key, or null if not found. */
export async function getDecryptedPrivateKey(
  keyId: string,
  orgId: string
): Promise<string | null> {
  const key = await db.query.deployKeys.findFirst({
    where: eq(deployKeys.id, keyId),
    columns: { privateKey: true, organizationId: true },
  });

  if (!key || key.organizationId !== orgId) return null;

  if (isEncrypted(key.privateKey)) {
    return decrypt(key.privateKey, orgId);
  }

  // Unencrypted legacy key.
  return key.privateKey;
}

/** Writes a 0600 temporary SSH key file and returns its path. Clean up with cleanupKeyFile(). */
export async function writeTemporaryKeyFile(privateKeyPem: string): Promise<string> {
  const filename = `.host-deploy-key-${nanoid(8)}`;
  const filepath = join(tmpdir(), filename);
  await writeFile(filepath, privateKeyPem, { mode: 0o600 });
  // writeFile's mode isn't always applied.
  await chmod(filepath, 0o600);
  return filepath;
}

/** Removes a temporary SSH key file. */
export async function cleanupKeyFile(filepath: string): Promise<void> {
  try {
    await unlink(filepath);
  } catch {
    // Best effort.
  }
}

/** GIT_SSH_COMMAND for a deploy key. Trusts host keys on first use and verifies them after. */
export function buildGitSshCommand(keyFilePath: string): string {
  return `ssh -i "${keyFilePath}" -o StrictHostKeyChecking=accept-new`;
}
