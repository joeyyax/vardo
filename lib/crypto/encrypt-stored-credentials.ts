// ---------------------------------------------------------------------------
// Encrypt credentials stored before they were encrypted on write: backup target
// configs, the registry_credentials setting, mesh outbound tokens, notification
// channel secrets and org env var values. Runs on every startup; values already encrypted
// are left alone.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { backupTargets, meshPeers, notificationChannels, orgEnvVars, systemSettings } from "@/lib/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { encrypt, encryptSystem, isEncrypted } from "./encrypt";
import { plaintextSecretKeys, sealTargetConfig } from "@/lib/backups/target-config";
import { sealOutboundToken } from "@/lib/mesh/outbound-token";
import { plaintextChannelSecretKeys, sealChannelConfig } from "@/lib/notifications/channel-config";
import { invalidateSettingsCache } from "@/lib/system-settings";
import { logger } from "@/lib/logger";
import type { KeyEscrowState } from "./key-escrow";

const log = logger.child("crypto");

/** Settings that hold credentials but have no writer that encrypts them. */
const CREDENTIAL_SETTINGS = ["registry_credentials"];

export type CredentialMigration = {
  targets: number;
  settings: number;
  peers: number;
  channels: number;
  orgEnvVars: number;
};

/**
 * Only a key this database already trusts may encrypt. Sealing under a wrong
 * key strands the value once the right key is restored.
 */
export function canEncryptStoredCredentials(state: KeyEscrowState | null): boolean {
  return state?.status.kind === "ok" && state.probe.undecryptable === 0;
}

export async function encryptStoredCredentials(): Promise<CredentialMigration> {
  const result: CredentialMigration = { targets: 0, settings: 0, peers: 0, channels: 0, orgEnvVars: 0 };

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

  const peers = await db
    .select({ id: meshPeers.id, outboundToken: meshPeers.outboundToken })
    .from(meshPeers)
    .where(isNotNull(meshPeers.outboundToken));

  for (const peer of peers) {
    if (!peer.outboundToken || isEncrypted(peer.outboundToken)) continue;
    const updated = await db
      .update(meshPeers)
      .set({ outboundToken: sealOutboundToken(peer.outboundToken), updatedAt: new Date() })
      .where(and(eq(meshPeers.id, peer.id), eq(meshPeers.outboundToken, peer.outboundToken)))
      .returning({ id: meshPeers.id });
    if (updated.length > 0) result.peers++;
  }

  const channels = await db
    .select({
      id: notificationChannels.id,
      organizationId: notificationChannels.organizationId,
      config: notificationChannels.config,
    })
    .from(notificationChannels);

  for (const channel of channels) {
    if (plaintextChannelSecretKeys(channel.config).length === 0) continue;
    const sealed = sealChannelConfig(channel.config, channel.organizationId);
    const updated = await db
      .update(notificationChannels)
      .set({ config: sealed, updatedAt: new Date() })
      .where(and(eq(notificationChannels.id, channel.id), eq(notificationChannels.config, channel.config)))
      .returning({ id: notificationChannels.id });
    if (updated.length > 0) result.channels++;
  }

  const envVars = await db
    .select({ id: orgEnvVars.id, organizationId: orgEnvVars.organizationId, value: orgEnvVars.value })
    .from(orgEnvVars);

  for (const envVar of envVars) {
    if (isEncrypted(envVar.value)) continue;
    const updated = await db
      .update(orgEnvVars)
      .set({ value: encrypt(envVar.value, envVar.organizationId), updatedAt: new Date() })
      .where(and(eq(orgEnvVars.id, envVar.id), eq(orgEnvVars.value, envVar.value)))
      .returning({ id: orgEnvVars.id });
    if (updated.length > 0) result.orgEnvVars++;
  }

  if (Object.values(result).some((n) => n > 0)) {
    log.info(
      `Encrypted stored credentials: ${result.targets} backup target(s), ${result.settings} setting(s), ` +
        `${result.peers} mesh peer(s), ${result.channels} notification channel(s), ` +
        `${result.orgEnvVars} org env var(s)`,
    );
  }
  return result;
}
