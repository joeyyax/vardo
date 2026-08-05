// ---------------------------------------------------------------------------
// Encryption key guard for restores
//
// Vardo's own database dump carries every app's env vars as ciphertext, and the
// key that wrote them is in no archive.
//
// Pure — shared by the engine (to refuse) and the UI (to explain).
// ---------------------------------------------------------------------------

/** Name of the system volume holding Vardo's own Postgres. */
export const SYSTEM_DB_VOLUME_NAME = "postgres";

/** True when an archive of this volume holds Vardo's own encrypted rows. */
export function holdsInstanceSecrets(vol: { appId: string | null; name: string | null }): boolean {
  return vol.appId === null && vol.name === SYSTEM_DB_VOLUME_NAME;
}

export type RestoreKeyVerdict =
  /** Nothing to check, or the archive and the running key agree. */
  | { kind: "proceed" }
  /** The archive predates fingerprinting — restore, then verify what decrypts. */
  | { kind: "unverifiable"; message: string }
  /** The archive's secrets were written with a different key. */
  | { kind: "blocked"; message: string };

/**
 * Decide whether a restore may overwrite this instance's rows. Only archives
 * carrying Vardo's own ciphertext are gated.
 */
export function checkRestoreKey(args: {
  archiveFingerprint: string | null;
  runningFingerprint: string | null;
  holdsInstanceSecrets: boolean;
}): RestoreKeyVerdict {
  if (!args.holdsInstanceSecrets) return { kind: "proceed" };

  if (!args.archiveFingerprint) {
    return {
      kind: "unverifiable",
      message:
        "This archive predates encryption key fingerprinting, so the key its secrets were written with cannot be confirmed.",
    };
  }

  if (!args.runningFingerprint) {
    return {
      kind: "blocked",
      message:
        `This archive's secrets were encrypted with key ${args.archiveFingerprint}, and no ENCRYPTION_MASTER_KEY ` +
        `is set — restoring it would produce env vars nothing can read.`,
    };
  }

  if (args.archiveFingerprint !== args.runningFingerprint) {
    return {
      kind: "blocked",
      message:
        `This archive's secrets were encrypted with key ${args.archiveFingerprint}, but this instance is running ` +
        `key ${args.runningFingerprint}. Restore ENCRYPTION_MASTER_KEY ${args.archiveFingerprint} first — the env ` +
        `vars in this archive cannot be recovered without it.`,
    };
  }

  return { kind: "proceed" };
}
