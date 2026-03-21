import { db } from "@/lib/db";
import { deployKeys } from "@/lib/db/schema";
import { decrypt, isEncrypted } from "@/lib/crypto/encrypt";
import { eq } from "drizzle-orm";
import { writeFile, unlink, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { nanoid } from "nanoid";

/**
 * Fetch and decrypt a deploy key's private key.
 * Returns the PEM-encoded private key string or null if not found.
 */
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

  // Fallback for any unencrypted keys (should not happen, but defensive)
  return key.privateKey;
}

/**
 * Write a temporary SSH key file and return the file path.
 * The file is created with mode 0600 (owner read-only) as required by SSH.
 *
 * Caller is responsible for cleaning up with cleanupKeyFile().
 */
export async function writeTemporaryKeyFile(privateKeyPem: string): Promise<string> {
  const filename = `.host-deploy-key-${nanoid(8)}`;
  const filepath = join(tmpdir(), filename);
  await writeFile(filepath, privateKeyPem, { mode: 0o600 });
  // Explicitly set permissions (writeFile mode doesn't always apply on all systems)
  await chmod(filepath, 0o600);
  return filepath;
}

/**
 * Remove a temporary SSH key file.
 */
export async function cleanupKeyFile(filepath: string): Promise<void> {
  try {
    await unlink(filepath);
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Build the GIT_SSH_COMMAND for use with a deploy key.
 * Disables host key checking for automated clones.
 */
export function buildGitSshCommand(keyFilePath: string): string {
  return `ssh -i "${keyFilePath}" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null`;
}
