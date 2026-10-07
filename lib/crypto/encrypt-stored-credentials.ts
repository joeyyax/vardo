// ---------------------------------------------------------------------------
// Encrypt credentials stored before they were encrypted on write: backup target
// configs and the registry_credentials setting. Runs on every startup; values
// already encrypted are left alone.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { backupTargets, systemSettings } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { encryptSystem, isEncrypted } from "./encrypt";
import { plaintextSecretKeys, sealTargetConfig } from "@/lib/backups/target-config";
import { invalidateSettingsCache } from "@/lib/system-settings";
import { logger } from "@/lib/logger";
import type { KeyEscrowState } from "./key-escrow";

const log = logger.child("crypto");

/** Settings that hold credentials but have no writer that encrypts them. */
const CREDENTIAL_SETTINGS = ["registry_credentials"];

export type CredentialMigration = { targets: number; settings: number };

/**
 * Only a key this database already trusts may encrypt. Sealing under a wrong
 * key strands the value once the right key is restored.
 */
export function canEncryptStoredCredentials(state: KeyEscrowState | null): boolean {
  return state?.status.kind === "ok" && state.probe.undecryptable === 0;
}

export async function encryptStoredCredentials(): Promise<CredentialMigration> {
  const result: CredentialMigration = { targets: 0, settings: 0 };

  const targets = await db
    .select({ id: backupTargets.id, organizationId: backupTargets.organizationId, config: backupTargets.config })
    .from(backupTargets);

  for (const target of targets) {
    if (plaintextSecretKeys(target.config).length === 0) continue;
    const sealed = sealTargetConfig(target.config as Record<string, unknown>, target.organizationId);
    // Guarded on the config read, so an edit made meanwhile isn't overwritten.
    const updated = await db
      .update(backupTargets)
      .set({ config: sealed as typeof target.config, updatedAt: new Date() })
      .where(and(eq(backupTargets.id, target.id), eq(backupTargets.config, target.config)))
      .returning({ id: backupTargets.id });
    if (updated.length > 0) result.targets++;
  }

  for (const key of CREDENTIAL_SETTINGS) {
    const row = await db.query.systemSettings.findFirst({ where: eq(systemSettings.key, key) });
    if (!row || isEncrypted(row.value)) continue;
    await db
      .update(systemSettings)
      .set({ value: encryptSystem(row.value), updatedAt: new Date() })
      .where(and(eq(systemSettings.key, key), eq(systemSettings.value, row.value)));
    invalidateSettingsCache(key);
    result.settings++;
  }

  if (result.targets > 0 || result.settings > 0) {
    log.info(`Encrypted stored credentials: ${result.targets} backup target(s), ${result.settings} setting(s)`);
  }
  return result;
}
