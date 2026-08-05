// ---------------------------------------------------------------------------
// Master key escrow state
//
// The database records which master key its ciphertext belongs to, and every
// startup checks the running key against it.
//
// WARNING: the recorded fingerprint must stay unencrypted. A value that needs
// the key to read answers nothing about whether the key is right.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { apps, systemSettings } from "@/lib/db/schema";
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

/** What the running key can actually open. */
export type DecryptProbe = {
  /** Values recognised as ciphertext. */
  encrypted: number;
  /** Of those, the ones the running key could not decrypt. */
  undecryptable: number;
  /** App names behind the failures, capped. */
  samples: string[];
};

/** Try the running key against every encrypted value this instance holds. */
export async function probeDecryptability(): Promise<DecryptProbe> {
  const probe: DecryptProbe = { encrypted: 0, undecryptable: 0, samples: [] };

  const rows = await db
    .select({ name: apps.name, orgId: apps.organizationId, envContent: apps.envContent })
    .from(apps);

  for (const row of rows) {
    if (!row.envContent) continue;
    const result = decryptOrFallback(row.envContent, row.orgId);
    if (!result.wasEncrypted) continue;
    probe.encrypted++;
    if (result.decryptFailed) {
      probe.undecryptable++;
      if (probe.samples.length < MAX_SAMPLES) probe.samples.push(row.name);
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

  return probe;
}

export type KeyEscrowState = {
  status: KeyFingerprintStatus;
  probe: DecryptProbe;
};

/**
 * Compare the running key against what this database recorded, recording it
 * when nothing is on file and the key opens everything already here.
 */
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

/** One line per state, for the startup log and the API. */
export function describeKeyEscrow(state: KeyEscrowState): {
  severity: "ok" | "warning" | "critical";
  headline: string;
} {
  const { status, probe } = state;

  if (status.kind === "unconfigured") {
    return { severity: "warning", headline: "ENCRYPTION_MASTER_KEY is not set — env vars cannot be encrypted." };
  }

  if (probe.undecryptable > 0) {
    return {
      severity: "critical",
      headline:
        `${probe.undecryptable} of ${probe.encrypted} encrypted values cannot be decrypted with the running ` +
        `ENCRYPTION_MASTER_KEY. Restore the key this data was encrypted with — the values cannot be recovered without it.`,
    };
  }

  switch (status.kind) {
    case "mismatch":
      return {
        severity: "critical",
        headline:
          `ENCRYPTION_MASTER_KEY does not match the key this database was written with ` +
          `(recorded ${status.recorded}, running ${status.running}).`,
      };
    case "unrecorded":
      return { severity: "warning", headline: `Encryption key ${status.running} is not yet recorded in this database.` };
    case "ok":
      return { severity: "ok", headline: `Encryption key ${status.fingerprint} matches this database.` };
  }
}

/** Reconcile and log. Startup path — never throws. */
export async function checkKeyEscrowAtStartup(): Promise<void> {
  try {
    const state = await reconcileKeyFingerprint();
    const { severity, headline } = describeKeyEscrow(state);
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
  } catch (err) {
    log.warn("Encryption key check skipped:", err);
  }
}
