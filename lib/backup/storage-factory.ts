// ---------------------------------------------------------------------------
// Backup Storage Factory
//
// Creates the appropriate BackupStorage adapter based on the backup target's
// type field. The engine calls this once per operation and then works
// exclusively through the BackupStorage interface.
// ---------------------------------------------------------------------------

import type { BackupStorage } from "./storage-port";
import { S3BackupStorage } from "./storage-s3";
import { SshBackupStorage } from "./storage-ssh";

type BackupTargetLike = {
  type: "s3" | "r2" | "b2" | "ssh";
  config: Record<string, unknown>;
};

export function createBackupStorage(target: BackupTargetLike): BackupStorage {
  if (target.type === "ssh") {
    return new SshBackupStorage(target.config as ConstructorParameters<typeof SshBackupStorage>[0]);
  }
  // s3, r2, and b2 all use S3-compatible APIs
  return new S3BackupStorage(target.config as ConstructorParameters<typeof S3BackupStorage>[0]);
}
