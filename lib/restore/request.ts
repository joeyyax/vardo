// Shared request parsing for the restore routes.

import { z } from "zod";
import { configuredRestoreTarget, masterKeySchema, restoreTargetSchema, type RestoreTarget } from "./source";

export const targetBodySchema = z.object({ target: restoreTargetSchema.optional() });

export const keyBodySchema = targetBodySchema.extend({
  backupKey: z.string().min(1, "Pick a backup"),
  /** Omitted when the host already holds the key, as after install.sh --restore. */
  masterKey: masterKeySchema.optional(),
});

/** The key the browser sent, else the one this instance runs with. Null when neither is a valid key. */
export function resolveMasterKey(sent: string | undefined, env = process.env): string | null {
  const parsed = masterKeySchema.safeParse(sent ?? env.ENCRYPTION_MASTER_KEY);
  return parsed.success ? parsed.data : null;
}

/** The target the browser sent, else the one set at install. */
export async function resolveTarget(sent: RestoreTarget | undefined): Promise<RestoreTarget | null> {
  return sent ?? (await configuredRestoreTarget());
}

/** A storage error, in a sentence safe to show. Never echoes credentials. */
export function storageErrorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  if (status === 403 || e?.name === "AccessDenied" || e?.name === "InvalidAccessKeyId" || e?.name === "SignatureDoesNotMatch") {
    return "The bucket refused these credentials.";
  }
  if (status === 404 || e?.name === "NoSuchBucket") return "That bucket doesn't exist.";
  if (e?.name === "ArchiveMissingError") return "That backup is no longer in the bucket.";
  if (e?.name === "ArchiveDecryptError") return e.message ?? "The backup couldn't be read.";
  return "Couldn't reach the backup storage. Check the endpoint and try again.";
}
