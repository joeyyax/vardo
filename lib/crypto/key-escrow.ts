// Records which master key the database's ciphertext belongs to; startup checks the running key against it.
// Keep the recorded fingerprint unencrypted, or it can't say whether the key is right.

import { db } from "@/lib/db";
import { apps, backupTargets, meshPeers, notificationChannels, orgEnvVars, systemSettings } from "@/lib/db/schema";
import { probeTargetSecrets } from "@/lib/backups/target-config";
import { probeChannelSecrets } from "@/lib/notifications/channel-config";
import { invalidateSettingsCache } from "@/lib/system-settings";
import { eq } from "drizzle-orm";
import { decryptOrFallback, decryptSystemOrFallback, runningKeyFingerprint } from "./encrypt";
import { evaluateKeyFingerprint, isKeyFingerprint, type KeyFingerprintStatus } from "./key-fingerprint";
import { logger } from "@/lib/logger";

const log = logger.child("key-escrow");

export const KEY_FINGERPRINT_SETTING = "encryption.key_fingerprint";

/** How many affected names a report lists. */
const MAX_SAMPLES = 5;

/** Read the fingerprint this database recorded. Null when none is recorded. */
export async function readRecordedFingerprint(): Promise<string | null> {
  const row = await db.query.systemSettings.findFirst({
    where: eq(systemSettings.key, KEY_FINGERPRINT_SETTING),
  });
  if (!row) return null;
  return isKeyFingerprint(row.value) ? row.value : null;
}

/** Record a fingerprint, overwriting whatever was there. */
export async function recordFingerprint(fingerprint: string): Promise<void> {
  await db
    .insert(systemSettings)
    .values({ key: KEY_FINGERPRINT_SETTING, value: fingerprint })
    .onConflictDoUpdate({
      target: systemSettings.key,
      set: { value: fingerprint, updatedAt: new Date() },
    });
  invalidateSettingsCache(KEY_FINGERPRINT_SETTING);
}

/** What the running key can open. */
export type DecryptProbe = {
  /** Values recognized as ciphertext. */
  encrypted: number;
  /** Of those, the ones the running key could not decrypt. */
  undecryptable: number;
  /** Names behind the failures, capped. */
  samples: string[];
};

/** Try the running key against every encrypted value this instance holds. */
export async function probeDecryptability(): Promise<DecryptProbe> {
  const probe: DecryptProbe = { encrypted: 0, undecryptable: 0, samples: [] };

  const rows = await db
    .select({ name: apps.name, orgId: apps.organizationId, envContent: apps.envContent, gitCredentials: apps.gitCredentials })
    .from(apps);

  for (const row of rows) {
    for (const value of [row.envContent, row.gitCredentials]) {
      if (!value) continue;
      const result = decryptOrFallback(value, row.orgId);
      if (!result.wasEncrypted) continue;
      probe.encrypted++;
      if (result.decryptFailed) {
        probe.undecryptable++;
        if (probe.samples.length < MAX_SAMPLES) probe.samples.push(row.name);
      }
    }
  }

  const settings = await db.select({ key: systemSettings.key, value: systemSettings.value }).from(systemSettings);
  for (const row of settings) {
    const result = decryptSystemOrFallback(row.value);
    if (!result.wasEncrypted) continue;
    probe.encrypted++;
    if (result.decryptFailed) {
      probe.undecryptable++;
      if (probe.samples.length < MAX_SAMPLES) probe.samples.push(`setting:${row.key}`);
    }
  }

  const targets = await db
    .select({ name: backupTargets.name, organizationId: backupTargets.organizationId, config: backupTargets.config })
    .from(backupTargets);
  for (const row of targets) {
    const result = probeTargetSecrets(row);
    probe.encrypted += result.encrypted;
    if (result.undecryptable > 0) {
      probe.undecryptable += result.undecryptable;
      if (probe.samples.length < MAX_SAMPLES) probe.samples.push(`target:${row.name}`);
    }
  }

  const peers = await db.select({ name: meshPeers.name, outboundToken: meshPeers.outboundToken }).from(meshPeers);
  for (const row of peers) {
    if (!row.outboundToken) continue;
    const result = decryptSystemOrFallback(row.outboundToken);
    if (!result.wasEncrypted) continue;
    probe.encrypted++;
    if (result.decryptFailed) {
      probe.undecryptable++;
      if (probe.samples.length < MAX_SAMPLES) probe.samples.push(`peer:${row.name}`);
    }
  }

  const channels = await db
    .select({
      name: notificationChannels.name,
      organizationId: notificationChannels.organizationId,
      config: notificationChannels.config,
    })
    .from(notificationChannels);
  for (const row of channels) {
    const result = probeChannelSecrets(row);
    probe.encrypted += result.encrypted;
    if (result.undecryptable > 0) {
      probe.undecryptable += result.undecryptable;
      if (probe.samples.length < MAX_SAMPLES) probe.samples.push(`channel:${row.name}`);
    }
  }

  const envVars = await db
    .select({ key: orgEnvVars.key, organizationId: orgEnvVars.organizationId, value: orgEnvVars.value })
    .from(orgEnvVars);
  for (const row of envVars) {
    const result = decryptOrFallback(row.value, row.organizationId);
    if (!result.wasEncrypted) continue;
    probe.encrypted++;
    if (result.decryptFailed) {
      probe.undecryptable++;
      if (probe.samples.length < MAX_SAMPLES) probe.samples.push(`org-env:${row.key}`);
    }
  }

  return probe;
}

export type KeyEscrowState = {
  status: KeyFingerprintStatus;
  probe: DecryptProbe;
};

/** Compares the running key against the recorded one. Records it when none is on file and it decrypts everything. */
export async function reconcileKeyFingerprint(): Promise<KeyEscrowState> {
  const running = runningKeyFingerprint();
  const recorded = await readRecordedFingerprint();
  const status = evaluateKeyFingerprint(recorded, running);

  // Without a key every decrypt fails for one already-reported reason.
  if (status.kind === "unconfigured") {
    return { status, probe: { encrypted: 0, undecryptable: 0, samples: [] } };
  }

  const probe = await probeDecryptability();

  if (status.kind === "unrecorded" && probe.undecryptable === 0) {
    await recordFingerprint(status.running);
    return { status: { kind: "ok", fingerprint: status.running }, probe };
  }

  return { status, probe };
}

export type KeyEscrowDescription = {
  severity: "ok" | "warning" | "critical";
  /** What state the key is in, in plain words. */
  headline: string;
  /** The consequence and the fix. */
  detail: string;
  /** Env var names and raw fingerprints, for the small print. */
  technical: string | null;
};

/** Plain wording per state, for the startup log and the API. */
export function describeKeyEscrow(state: KeyEscrowState): KeyEscrowDescription {
  const { status, probe } = state;

  if (status.kind === "unconfigured") {
    return {
      severity: "warning",
      headline: "Backups aren't encrypted",
      detail:
        "This server has no encryption key, so new backups and saved secrets are stored unencrypted. Set a key in the server's environment, then restart.",
      technical: "ENCRYPTION_MASTER_KEY is not set.",
    };
  }

  if (probe.undecryptable > 0) {
    return {
      severity: "critical",
      headline: "Some saved secrets can't be read",
      detail:
        `${probe.undecryptable} of ${probe.encrypted} encrypted items won't open with this server's key. ` +
        "Put back the key they were encrypted with, then restart. Without it they can't be recovered.",
      technical: "Running ENCRYPTION_MASTER_KEY can't decrypt them.",
    };
  }

  switch (status.kind) {
    case "mismatch":
      return {
        severity: "critical",
        headline: "This server has a different key",
        detail:
          "It isn't the key this data was encrypted with, so backups made with the original won't restore. " +
          "Put the original key back, then restart.",
        technical: `ENCRYPTION_MASTER_KEY: recorded ${status.recorded}, running ${status.running}.`,
      };
    case "unrecorded":
      return {
        severity: "warning",
        headline: "This server's key isn't recorded yet",
        detail: "Vardo can't warn you if the key changes until it records one. It records on the next check.",
        technical: `Running key ${status.running}.`,
      };
    case "ok":
      return {
        severity: "ok",
        headline: "Your backups can be restored",
        detail:
          "Backups and saved secrets are encrypted with this server's key. " +
          (probe.encrypted === 0
            ? "Nothing is encrypted here yet."
            : probe.encrypted === 1
              ? "It opens the 1 encrypted item here."
              : `It opens all ${probe.encrypted} encrypted items here.`),
        technical: null,
      };
  }
}

/** Reconciles and logs. Never throws; null when the check failed. */
export async function checkKeyEscrowAtStartup(): Promise<KeyEscrowState | null> {
  try {
    const state = await reconcileKeyFingerprint();
    const { severity, headline: title, detail, technical } = describeKeyEscrow(state);
    const headline = [title + ".", detail, technical].filter(Boolean).join(" ");
    if (severity === "critical") {
      log.error(headline);
      if (state.probe.samples.length > 0) {
        log.error(`Affected: ${state.probe.samples.join(", ")}`);
      }
    } else if (severity === "warning") {
      log.warn(headline);
    } else {
      log.info(headline);
    }
    return state;
  } catch (err) {
    log.warn("Encryption key check skipped:", err);
    return null;
  }
}
